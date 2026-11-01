import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import type { Logger } from '../util/logger.js';
import { silentLogger } from '../util/logger.js';
import type { EgressPolicy, PolicyRejectionReason } from './egressPolicy.js';

export interface BlockedConnection {
  kind: 'http' | 'connect' | 'upgrade' | 'auth';
  hostname: string;
  port: number;
  reason: PolicyRejectionReason | 'proxy_protocol';
  message: string;
}

export interface EgressProxyOptions {
  policy: EgressPolicy;
  onBlocked?: (event: BlockedConnection) => void;
  logger?: Logger;
  upstreamTimeoutMs?: number;
}

export interface ProxyEndpoint {
  server: string;
  username: string;
  password: string;
}

/** Set on synthetic 502 responses so the session can report a connection failure, not an HTTP 502 from the app. */
export const UPSTREAM_ERROR_HEADER = 'x-investigator-upstream-error';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authorization',
  'proxy-authenticate',
  'proxy-connection',
  'te',
  'trailer',
  'upgrade',
]);

function stripHopByHop(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue;
    out[name] = value;
  }
  return out;
}

function parseAuthority(authority: string): { hostname: string; port: number } | null {
  const match = /^(\[[0-9a-fA-F:.]+\]|[^:[\]]+):(\d{1,5})$/.exec(authority);
  if (!match) return null;
  return { hostname: match[1]!, port: Number(match[2]) };
}

/**
 * A minimal authenticated HTTP forward proxy bound to loopback. One instance
 * serves exactly one investigation's browser context.
 *
 * Every outbound connection - initial navigations, redirects, subresources,
 * page-initiated navigations, fetch/XHR and CONNECT tunnels for HTTPS/WSS -
 * is validated against the {@link EgressPolicy}. The proxy connects to the
 * IP address that the policy validated instead of re-resolving the hostname,
 * which closes the DNS-rebinding window between check and use.
 *
 * Limitations: it only sees traffic that Chromium sends through the proxy
 * (see README "Security model"), and for HTTPS it sees host and port only.
 */
export class EgressProxy {
  private server: http.Server | null = null;
  private readonly sockets = new Set<Duplex>();
  private readonly username = `inv-${crypto.randomBytes(6).toString('hex')}`;
  private readonly password = crypto.randomBytes(18).toString('base64url');
  private readonly expectedAuth: Buffer;
  private readonly logger: Logger;
  private readonly upstreamTimeoutMs: number;

  constructor(private readonly options: EgressProxyOptions) {
    this.expectedAuth = Buffer.from(
      `Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}`,
    );
    this.logger = options.logger ?? silentLogger;
    this.upstreamTimeoutMs = options.upstreamTimeoutMs ?? 30_000;
  }

  async start(): Promise<ProxyEndpoint> {
    const server = http.createServer((req, res) => void this.handleHttp(req, res));
    server.on('connect', (req, socket, head) => void this.handleConnect(req, socket, head));
    server.on('upgrade', (req, socket) => {
      // Chromium tunnels ws:// through CONNECT; a plain-HTTP upgrade is unexpected.
      this.block({
        kind: 'upgrade',
        hostname: req.headers.host ?? '',
        port: 0,
        reason: 'proxy_protocol',
        message: 'HTTP upgrade via proxy is not supported',
      });
      socket.destroy();
    });
    server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
    server.on('clientError', (_err, socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    this.server = server;
    const address = server.address() as net.AddressInfo;
    return { server: `http://127.0.0.1:${address.port}`, username: this.username, password: this.password };
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private block(event: BlockedConnection): void {
    this.logger.debug('egress blocked', { ...event });
    this.options.onBlocked?.(event);
  }

  private isAuthorized(header: string | undefined): boolean {
    if (!header) return false;
    const given = Buffer.from(header);
    return given.length === this.expectedAuth.length && crypto.timingSafeEqual(given, this.expectedAuth);
  }

  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.isAuthorized(req.headers['proxy-authorization'])) {
      res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="investigator"', 'Content-Length': '0' });
      res.end();
      return;
    }
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      res.writeHead(400).end('Bad proxy request');
      return;
    }
    if (target.protocol !== 'http:') {
      res.writeHead(400).end('Only absolute http: URLs are proxied directly');
      return;
    }
    const port = target.port ? Number(target.port) : 80;
    const decision = await this.options.policy.checkDestination(target.hostname, port, 'http:');
    if (!decision.allowed && decision.reason === 'dns_failed') {
      // An unresolvable host is an ordinary network failure, not a policy decision.
      res.writeHead(502, { 'Content-Type': 'text/plain', [UPSTREAM_ERROR_HEADER]: 'ENOTFOUND' });
      res.end('Upstream host could not be resolved');
      return;
    }
    if (!decision.allowed) {
      this.block({
        kind: 'http',
        hostname: target.hostname,
        port,
        reason: decision.reason,
        message: decision.message,
      });
      res.writeHead(403, { 'Content-Type': 'text/plain', 'X-Investigator-Blocked': decision.reason });
      res.end(`Blocked by investigator egress policy: ${decision.message}`);
      return;
    }

    const upstream = http.request({
      host: decision.address,
      family: decision.family,
      port,
      method: req.method,
      path: `${target.pathname}${target.search}`,
      // RFC 9112 3.2.2: with an absolute-form target, Host is replaced by the target authority.
      headers: { ...stripHopByHop(req.headers), host: target.host },
      setHost: false,
      agent: false,
      timeout: this.upstreamTimeoutMs,
    });
    upstream.on('response', (upstreamRes) => {
      const headers = stripHopByHop(upstreamRes.headers);
      // Only the proxy may emit its marker headers; a target cannot spoof them.
      for (const name of Object.keys(headers)) {
        if (name.toLowerCase().startsWith('x-investigator-')) delete headers[name];
      }
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, headers);
      upstreamRes.pipe(res);
    });
    upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
    upstream.on('error', (error) => {
      this.logger.debug('upstream error', { host: target.hostname, error: error.message });
      if (!res.headersSent) {
        const code = (error as NodeJS.ErrnoException).code ?? 'UPSTREAM_ERROR';
        res.writeHead(502, { 'Content-Type': 'text/plain', [UPSTREAM_ERROR_HEADER]: code });
        res.end(`Upstream connection failed: ${code}`);
      } else {
        res.destroy();
      }
    });
    req.pipe(upstream);
  }

  private async handleConnect(req: http.IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    client.on('error', () => client.destroy());
    if (!this.isAuthorized(req.headers['proxy-authorization'])) {
      client.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="investigator"\r\nContent-Length: 0\r\n\r\n',
      );
      return;
    }
    const authority = parseAuthority(req.url ?? '');
    if (!authority) {
      client.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const decision = await this.options.policy.checkDestination(authority.hostname, authority.port);
    if (!decision.allowed && decision.reason === 'dns_failed') {
      client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    if (!decision.allowed) {
      this.block({ kind: 'connect', ...authority, reason: decision.reason, message: decision.message });
      client.end(
        `HTTP/1.1 403 Forbidden\r\nX-Investigator-Blocked: ${decision.reason}\r\nContent-Length: 0\r\n\r\n`,
      );
      return;
    }
    const upstream = net.connect({ host: decision.address, port: authority.port, family: decision.family });
    this.sockets.add(upstream);
    upstream.setTimeout(this.upstreamTimeoutMs, () => upstream.destroy());
    upstream.on('close', () => {
      this.sockets.delete(upstream);
      client.destroy();
    });
    client.on('close', () => upstream.destroy());
    upstream.on('error', () => {
      if (client.writable) client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
    });
    upstream.on('connect', () => {
      upstream.setTimeout(0);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
  }
}
