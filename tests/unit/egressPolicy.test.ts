import { describe, expect, it } from 'vitest';
import { EgressPolicy, type HostResolver } from '../../src/security/egressPolicy.js';

const resolverFor =
  (table: Record<string, string[]>): HostResolver =>
  async (hostname) => {
    const addresses = table[hostname];
    if (!addresses) throw new Error('ENOTFOUND');
    return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };

const resolve = resolverFor({
  'example.com': ['93.184.216.34'],
  'shop.example.com': ['93.184.216.35'],
  'rebind.attacker.test': ['127.0.0.1'],
  'mixed.attacker.test': ['93.184.216.34', '10.0.0.5'],
  'metadata.attacker.test': ['169.254.169.254'],
  'v6.example.com': ['2606:4700:4700::1111'],
  'mapped.attacker.test': ['::ffff:192.168.0.1'],
  'app.local-dev.test': ['127.0.0.1'],
});

function policy(options: Partial<{ allowedHosts: string[]; allowedLocalOrigins: string[] }> = {}) {
  return new EgressPolicy({ allowedHosts: [], allowedLocalOrigins: [], resolve, ...options });
}

describe('EgressPolicy URL validation', () => {
  it('allows public http(s) URLs and returns the pinned address', async () => {
    const decision = await policy().checkUrl('https://example.com/catalog?page=2');
    expect(decision).toMatchObject({ allowed: true, address: '93.184.216.34', addressClass: 'public' });
  });

  it.each([
    'file:///etc/passwd',
    'ftp://example.com/',
    'javascript:alert(1)',
    'data:text/html,hi',
    'chrome://settings',
    'ws://example.com/',
  ])('rejects unsupported scheme %s', async (url) => {
    expect(await policy().checkUrl(url)).toMatchObject({ allowed: false, reason: 'scheme_not_allowed' });
  });

  it('rejects unparsable URLs and embedded credentials', async () => {
    expect(await policy().checkUrl('not a url')).toMatchObject({ allowed: false, reason: 'invalid_url' });
    expect(await policy().checkUrl('https://user:pass@example.com/')).toMatchObject({
      allowed: false,
      reason: 'credentials_in_url',
    });
  });

  it.each([
    'http://127.0.0.1/',
    'http://[::1]/',
    'http://2130706433/', // decimal form of 127.0.0.1
    'http://0x7f.0.0.1/',
    'http://10.0.0.1/',
    'http://192.168.1.1:8080/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[fd00:ec2::254]/',
    'http://0.0.0.0/',
  ])('blocks private/loopback/metadata literal %s', async (url) => {
    expect(await policy().checkUrl(url)).toMatchObject({ allowed: false, reason: 'blocked_address' });
  });

  it.each([
    'http://localhost:3000/',
    'http://app.localhost/',
    'http://printer.local/',
    'http://metadata.google.internal/',
    'http://intranet/',
  ])('blocks internal-looking hostname %s', async (url) => {
    expect(await policy().checkUrl(url)).toMatchObject({ allowed: false, reason: 'blocked_hostname' });
  });

  it('blocks hostnames that resolve to private addresses (DNS rebinding style)', async () => {
    expect(await policy().checkUrl('http://rebind.attacker.test/')).toMatchObject({
      allowed: false,
      reason: 'blocked_address',
    });
    expect(await policy().checkUrl('http://mapped.attacker.test/')).toMatchObject({
      allowed: false,
      reason: 'blocked_address',
    });
  });

  it('rejects a host if any resolved address is private', async () => {
    expect(await policy().checkUrl('http://mixed.attacker.test/')).toMatchObject({
      allowed: false,
      reason: 'blocked_address',
    });
  });

  it('reports DNS failures', async () => {
    expect(await policy().checkUrl('http://does-not-exist.test/')).toMatchObject({
      allowed: false,
      reason: 'dns_failed',
    });
  });

  it('supports IPv6 public destinations', async () => {
    expect(await policy().checkUrl('http://v6.example.com/')).toMatchObject({ allowed: true, family: 6 });
  });
});

describe('EgressPolicy host allowlist', () => {
  it('only allows listed hosts and wildcard subdomains', async () => {
    const p = policy({ allowedHosts: ['example.com', '*.example.com'] });
    expect((await p.checkUrl('https://example.com/')).allowed).toBe(true);
    expect((await p.checkUrl('https://shop.example.com/')).allowed).toBe(true);
    expect(await p.checkUrl('https://evil-example.com/')).toMatchObject({
      allowed: false,
      reason: 'host_not_allowlisted',
    });
    expect(await p.checkUrl('https://example.com.evil.test/')).toMatchObject({
      allowed: false,
      reason: 'host_not_allowlisted',
    });
  });

  it('wildcards do not match the apex domain', async () => {
    const p = policy({ allowedHosts: ['*.example.com'] });
    expect(await p.checkUrl('https://example.com/')).toMatchObject({
      allowed: false,
      reason: 'host_not_allowlisted',
    });
  });
});

describe('EgressPolicy local origins', () => {
  it('allows an explicitly configured local origin, including its exact port only', async () => {
    const p = policy({ allowedLocalOrigins: ['http://127.0.0.1:4173'] });
    expect(await p.checkUrl('http://127.0.0.1:4173/catalog')).toMatchObject({
      allowed: true,
      viaLocalOrigin: true,
    });
    expect(await p.checkUrl('http://127.0.0.1:4174/')).toMatchObject({
      allowed: false,
      reason: 'blocked_address',
    });
    expect(await p.checkUrl('https://127.0.0.1:4173/')).toMatchObject({ allowed: false });
  });

  it('allows a named local origin that resolves to loopback', async () => {
    const p = policy({ allowedLocalOrigins: ['http://app.local-dev.test:8080'] });
    expect(await p.checkUrl('http://app.local-dev.test:8080/')).toMatchObject({
      allowed: true,
      address: '127.0.0.1',
    });
  });

  it('never allows cloud metadata, even via a local origin', async () => {
    const p = policy({ allowedLocalOrigins: ['http://169.254.169.254', 'http://metadata.attacker.test'] });
    expect(await p.checkUrl('http://169.254.169.254/')).toMatchObject({
      allowed: false,
      reason: 'blocked_address',
    });
    expect(await p.checkUrl('http://metadata.attacker.test/')).toMatchObject({
      allowed: false,
      reason: 'blocked_address',
    });
  });

  it('matches CONNECT destinations (unknown scheme) on host and port', async () => {
    const p = policy({ allowedLocalOrigins: ['https://127.0.0.1:8443'] });
    expect(await p.checkDestination('127.0.0.1', 8443)).toMatchObject({ allowed: true });
    expect(await p.checkDestination('127.0.0.1', 22)).toMatchObject({ allowed: false });
  });
});
