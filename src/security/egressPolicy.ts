import dns from 'node:dns';
import net from 'node:net';
import { classifyIp, isAlwaysBlockedClass, type IpClass } from './ipAddress.js';

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Injected so tests can simulate DNS answers (including rebinding-style answers). */
export type HostResolver = (hostname: string) => Promise<ResolvedAddress[]>;

export const systemResolver: HostResolver = async (hostname) => {
  const results = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return results.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }));
};

export type PolicyRejectionReason =
  | 'invalid_url'
  | 'scheme_not_allowed'
  | 'credentials_in_url'
  | 'host_not_allowlisted'
  | 'blocked_hostname'
  | 'blocked_address'
  | 'dns_failed';

export type PolicyDecision =
  | { allowed: true; address: string; family: 4 | 6; addressClass: IpClass; viaLocalOrigin: boolean }
  | { allowed: false; reason: PolicyRejectionReason; message: string };

export interface EgressPolicyOptions {
  allowedHosts: string[];
  allowedLocalOrigins: string[];
  resolve?: HostResolver;
}

const ALLOWED_SCHEMES = new Set(['http:', 'https:']);
const DEFAULT_PORTS: Record<string, number> = { 'http:': 80, 'https:': 443 };

// Names that conventionally resolve to internal infrastructure.
const BLOCKED_HOST_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.intranet',
  '.home.arpa',
  '.lan',
  '.corp',
];
const BLOCKED_HOSTS = new Set(['localhost', 'metadata', 'metadata.google.internal', 'instance-data']);

function stripBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/**
 * Decides whether the browser may contact a destination. The same object is
 * used for (1) validating URLs supplied by the MCP client and (2) every
 * connection made by the browser through the egress proxy, so redirects,
 * subresources and page-initiated navigations are all re-validated.
 */
export class EgressPolicy {
  private readonly allowedHosts: string[];
  private readonly localOrigins: { protocol: string; hostname: string; port: number }[];
  private readonly resolve: HostResolver;

  constructor(options: EgressPolicyOptions) {
    this.allowedHosts = options.allowedHosts.map((h) => h.toLowerCase());
    this.localOrigins = options.allowedLocalOrigins.map((origin) => {
      const url = new URL(origin);
      return {
        protocol: url.protocol,
        hostname: stripBrackets(url.hostname.toLowerCase()),
        port: url.port ? Number(url.port) : (DEFAULT_PORTS[url.protocol] ?? 0),
      };
    });
    this.resolve = options.resolve ?? systemResolver;
  }

  /** Parses and statically checks a URL (no DNS). */
  parseUrl(
    raw: string,
  ): { ok: true; url: URL } | { ok: false; reason: PolicyRejectionReason; message: string } {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { ok: false, reason: 'invalid_url', message: 'URL could not be parsed' };
    }
    if (!ALLOWED_SCHEMES.has(url.protocol)) {
      return {
        ok: false,
        reason: 'scheme_not_allowed',
        message: `Scheme "${url.protocol}" is not allowed; only http: and https: are supported`,
      };
    }
    if (url.username || url.password) {
      return {
        ok: false,
        reason: 'credentials_in_url',
        message: 'URLs with embedded credentials are not allowed',
      };
    }
    return { ok: true, url };
  }

  /** Full validation of a URL, including DNS resolution of its host. */
  async checkUrl(raw: string): Promise<PolicyDecision> {
    const parsed = this.parseUrl(raw);
    if (!parsed.ok) return { allowed: false, reason: parsed.reason, message: parsed.message };
    const { url } = parsed;
    const port = url.port ? Number(url.port) : (DEFAULT_PORTS[url.protocol] ?? 0);
    return this.checkDestination(url.hostname, port, url.protocol);
  }

  isLocalOrigin(hostname: string, port: number, protocol?: string): boolean {
    const host = stripBrackets(hostname.toLowerCase());
    return this.localOrigins.some(
      (o) => o.hostname === host && o.port === port && (protocol === undefined || o.protocol === protocol),
    );
  }

  isHostAllowlisted(hostname: string): boolean {
    if (this.allowedHosts.length === 0) return true;
    const host = stripBrackets(hostname.toLowerCase());
    return this.allowedHosts.some((pattern) => {
      const p = stripBrackets(pattern);
      if (p.startsWith('*.')) return host.endsWith(p.slice(1)) && host.length > p.length - 1;
      return host === p;
    });
  }

  /**
   * Validates a host/port pair and returns the single address that must be
   * used for the connection. Callers must connect to `address` (not re-resolve
   * the hostname) so that DNS rebinding cannot swap in a different address
   * between the check and the connection.
   *
   * `protocol` is unknown for CONNECT tunnels; in that case a local origin
   * matches on host and port only.
   */
  async checkDestination(rawHostname: string, port: number, protocol?: string): Promise<PolicyDecision> {
    const hostname = stripBrackets(rawHostname.toLowerCase()).replace(/\.$/, '');
    if (!hostname) return { allowed: false, reason: 'invalid_url', message: 'Empty hostname' };
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { allowed: false, reason: 'invalid_url', message: `Invalid port ${port}` };
    }

    const viaLocalOrigin = this.isLocalOrigin(hostname, port, protocol);

    if (!viaLocalOrigin) {
      if (!this.isHostAllowlisted(hostname)) {
        return {
          allowed: false,
          reason: 'host_not_allowlisted',
          message: `Host "${hostname}" is not in INVESTIGATOR_ALLOWED_HOSTS`,
        };
      }
      const isIpLiteral = net.isIP(hostname) !== 0;
      if (
        !isIpLiteral &&
        (BLOCKED_HOSTS.has(hostname) ||
          BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix)) ||
          !hostname.includes('.'))
      ) {
        return {
          allowed: false,
          reason: 'blocked_hostname',
          message: `Host "${hostname}" looks like an internal name and is blocked`,
        };
      }
    }

    let addresses: ResolvedAddress[];
    if (net.isIP(hostname) !== 0) {
      addresses = [{ address: hostname, family: net.isIPv6(hostname) ? 6 : 4 }];
    } else {
      try {
        addresses = await this.resolve(hostname);
      } catch {
        return { allowed: false, reason: 'dns_failed', message: `Could not resolve "${hostname}"` };
      }
      if (addresses.length === 0) {
        return { allowed: false, reason: 'dns_failed', message: `No addresses for "${hostname}"` };
      }
    }

    // Every resolved address must be acceptable; one bad answer rejects the
    // host, which defeats round-robin answers that mix public and private IPs.
    for (const { address } of addresses) {
      const cls = classifyIp(address);
      if (isAlwaysBlockedClass(cls)) {
        return {
          allowed: false,
          reason: 'blocked_address',
          message: `Host "${hostname}" resolves to a blocked ${cls} address`,
        };
      }
      if (cls !== 'public' && !viaLocalOrigin) {
        return {
          allowed: false,
          reason: 'blocked_address',
          message: `Host "${hostname}" resolves to a non-public (${cls}) address; add the exact origin to INVESTIGATOR_ALLOWED_LOCAL_ORIGINS to investigate a local app`,
        };
      }
    }

    const chosen = addresses[0]!;
    return {
      allowed: true,
      address: chosen.address,
      family: chosen.family,
      addressClass: classifyIp(chosen.address),
      viaLocalOrigin,
    };
  }
}
