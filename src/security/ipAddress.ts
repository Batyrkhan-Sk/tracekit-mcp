import net from 'node:net';

/**
 * Classification of IP addresses for SSRF protection. Implemented with explicit
 * CIDR tables (rather than ad-hoc string prefixes) so that IPv4-mapped,
 * NAT64 and 6to4 IPv6 forms are checked against the embedded IPv4 address.
 */

export type IpClass =
  | 'public'
  | 'loopback'
  | 'private'
  | 'link-local'
  | 'cloud-metadata'
  | 'unspecified'
  | 'carrier-grade-nat'
  | 'multicast'
  | 'reserved'
  | 'documentation'
  | 'unique-local'
  | 'invalid';

interface Range {
  base: bigint;
  prefix: number;
  bits: 32 | 128;
  cls: IpClass;
}

function parseIpv4(address: string): bigint | null {
  if (net.isIPv4(address) === false) return null;
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return parts.reduce((acc, part) => (acc << 8n) | BigInt(part), 0n);
}

function parseIpv6(address: string): bigint | null {
  let addr = address;
  const zone = addr.indexOf('%');
  if (zone !== -1) addr = addr.slice(0, zone);
  if (!net.isIPv6(addr)) return null;
  // Expand an embedded dotted IPv4 tail (e.g. ::ffff:127.0.0.1).
  const lastColon = addr.lastIndexOf(':');
  const tail = addr.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIpv4(tail);
    if (v4 === null) return null;
    addr = `${addr.slice(0, lastColon + 1)}${((v4 >> 16n) & 0xffffn).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const [head = '', rest] = addr.split('::');
  const headParts = head ? head.split(':') : [];
  const restParts = rest !== undefined && rest !== '' ? rest.split(':') : [];
  const missing = 8 - headParts.length - restParts.length;
  if (rest === undefined && headParts.length !== 8) return null;
  const groups = [...headParts, ...Array<string>(rest === undefined ? 0 : missing).fill('0'), ...restParts];
  if (groups.length !== 8) return null;
  return groups.reduce((acc, group) => (acc << 16n) | BigInt(parseInt(group, 16)), 0n);
}

function cidr(text: string, cls: IpClass): Range {
  const [addr = '', prefixText = ''] = text.split('/');
  const prefix = Number(prefixText);
  const v4 = parseIpv4(addr);
  if (v4 !== null) return { base: v4, prefix, bits: 32, cls };
  const v6 = parseIpv6(addr);
  if (v6 === null) throw new Error(`bad CIDR ${text}`);
  return { base: v6, prefix, bits: 128, cls };
}

// Order matters: the first match wins, so specific entries precede broad ones.
const IPV4_RANGES: Range[] = [
  cidr('169.254.169.254/32', 'cloud-metadata'), // AWS, GCP, Azure, OpenStack, ...
  cidr('100.100.100.200/32', 'cloud-metadata'), // Alibaba Cloud
  cidr('192.0.0.192/32', 'cloud-metadata'), // Oracle Cloud
  cidr('0.0.0.0/8', 'unspecified'),
  cidr('10.0.0.0/8', 'private'),
  cidr('100.64.0.0/10', 'carrier-grade-nat'),
  cidr('127.0.0.0/8', 'loopback'),
  cidr('169.254.0.0/16', 'link-local'),
  cidr('172.16.0.0/12', 'private'),
  cidr('192.0.0.0/24', 'reserved'),
  cidr('192.0.2.0/24', 'documentation'),
  cidr('192.88.99.0/24', 'reserved'),
  cidr('192.168.0.0/16', 'private'),
  cidr('198.18.0.0/15', 'reserved'),
  cidr('198.51.100.0/24', 'documentation'),
  cidr('203.0.113.0/24', 'documentation'),
  cidr('224.0.0.0/4', 'multicast'),
  cidr('240.0.0.0/4', 'reserved'),
];

const IPV6_RANGES: Range[] = [
  cidr('fd00:ec2::254/128', 'cloud-metadata'), // AWS IPv6 metadata
  cidr('::/128', 'unspecified'),
  cidr('::1/128', 'loopback'),
  cidr('100::/64', 'reserved'), // discard prefix
  cidr('2001:db8::/32', 'documentation'),
  cidr('2001::/23', 'reserved'), // IETF protocol assignments incl. Teredo
  cidr('fc00::/7', 'unique-local'),
  cidr('fe80::/10', 'link-local'),
  cidr('fec0::/10', 'reserved'), // deprecated site-local
  cidr('ff00::/8', 'multicast'),
];

function inRange(value: bigint, range: Range): boolean {
  const shift = BigInt(range.bits - range.prefix);
  return value >> shift === range.base >> shift;
}

function classifyV4(value: bigint): IpClass {
  return IPV4_RANGES.find((r) => inRange(value, r))?.cls ?? 'public';
}

/** Extracts an IPv4 address embedded in an IPv6 address by a translation scheme. */
function embeddedIpv4(value: bigint): bigint | null {
  const top96 = value >> 32n;
  if (top96 === 0xffffn) return value & 0xffffffffn; // ::ffff:a.b.c.d (IPv4-mapped)
  if (top96 === 0n && value > 1n) return value & 0xffffffffn; // ::a.b.c.d (deprecated IPv4-compatible)
  if (value >> 32n === 0x64ff9b0000000000000000n) return value & 0xffffffffn; // 64:ff9b::/96 NAT64
  if (value >> 112n === 0x2002n) return (value >> 80n) & 0xffffffffn; // 2002::/16 6to4
  return null;
}

export function classifyIp(address: string): IpClass {
  const v4 = parseIpv4(address);
  if (v4 !== null) return classifyV4(v4);
  const v6 = parseIpv6(address);
  if (v6 === null) return 'invalid';
  const special = IPV6_RANGES.find((r) => inRange(v6, r));
  if (special) return special.cls;
  const embedded = embeddedIpv4(v6);
  if (embedded !== null) return classifyV4(embedded);
  return 'public';
}

export function isPublicIp(address: string): boolean {
  return classifyIp(address) === 'public';
}

/** Hostnames that must never be contacted, regardless of local-origin allowances. */
export function isAlwaysBlockedClass(cls: IpClass): boolean {
  return cls === 'cloud-metadata' || cls === 'invalid' || cls === 'multicast' || cls === 'unspecified';
}
