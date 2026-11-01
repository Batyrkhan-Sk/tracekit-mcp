import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EgressPolicy } from '../../src/security/egressPolicy.js';
import { EgressProxy, type BlockedConnection, type ProxyEndpoint } from '../../src/security/egressProxy.js';

let upstream: http.Server;
let upstreamPort: number;
const seenHostHeaders: string[] = [];

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    seenHostHeaders.push(req.headers.host ?? '');
    res.end(`upstream:${req.url}`);
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamPort = (upstream.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => upstream.close(() => r())));

/** Sends an absolute-URI request through the proxy. */
function viaProxy(
  endpoint: ProxyEndpoint,
  target: string,
  auth = true,
): Promise<{ status: number; body: string }> {
  const proxyUrl = new URL(endpoint.server);
  const headers: Record<string, string> = {};
  if (auth)
    headers['Proxy-Authorization'] =
      `Basic ${Buffer.from(`${endpoint.username}:${endpoint.password}`).toString('base64')}`;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: proxyUrl.hostname, port: proxyUrl.port, path: target, method: 'GET', headers },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function connectVia(endpoint: ProxyEndpoint, authority: string): Promise<string> {
  const proxyUrl = new URL(endpoint.server);
  const auth = Buffer.from(`${endpoint.username}:${endpoint.password}`).toString('base64');
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(proxyUrl.port), proxyUrl.hostname, () => {
      socket.write(
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`,
      );
    });
    socket.once('data', (chunk) => {
      resolve(chunk.toString().split('\r\n')[0] ?? '');
      socket.destroy();
    });
    socket.on('error', reject);
  });
}

describe('EgressProxy', () => {
  it('requires proxy authentication', async () => {
    const proxy = new EgressProxy({
      policy: new EgressPolicy({ allowedHosts: [], allowedLocalOrigins: [] }),
    });
    const endpoint = await proxy.start();
    try {
      const res = await viaProxy(endpoint, `http://127.0.0.1:${upstreamPort}/`, false);
      expect(res.status).toBe(407);
    } finally {
      await proxy.close();
    }
  });

  it('forwards allowed requests and blocks private destinations', async () => {
    const blocked: BlockedConnection[] = [];
    const policy = new EgressPolicy({
      allowedHosts: [],
      allowedLocalOrigins: [`http://127.0.0.1:${upstreamPort}`],
    });
    const proxy = new EgressProxy({ policy, onBlocked: (e) => blocked.push(e) });
    const endpoint = await proxy.start();
    try {
      const ok = await viaProxy(endpoint, `http://127.0.0.1:${upstreamPort}/hello?x=1`);
      expect(ok).toEqual({ status: 200, body: 'upstream:/hello?x=1' });

      const denied = await viaProxy(endpoint, 'http://10.0.0.1/admin');
      expect(denied.status).toBe(403);
      const metadata = await viaProxy(endpoint, 'http://169.254.169.254/latest/meta-data');
      expect(metadata.status).toBe(403);
      expect(blocked.map((b) => [b.hostname, b.reason])).toEqual([
        ['10.0.0.1', 'blocked_address'],
        ['169.254.169.254', 'blocked_address'],
      ]);
    } finally {
      await proxy.close();
    }
  });

  it('validates CONNECT tunnels', async () => {
    const blocked: BlockedConnection[] = [];
    const policy = new EgressPolicy({
      allowedHosts: [],
      allowedLocalOrigins: [`https://127.0.0.1:${upstreamPort}`],
    });
    const proxy = new EgressProxy({ policy, onBlocked: (e) => blocked.push(e) });
    const endpoint = await proxy.start();
    try {
      expect(await connectVia(endpoint, `127.0.0.1:${upstreamPort}`)).toBe(
        'HTTP/1.1 200 Connection Established',
      );
      expect(await connectVia(endpoint, '192.168.0.10:443')).toMatch(/^HTTP\/1.1 403/);
      expect(blocked).toHaveLength(1);
    } finally {
      await proxy.close();
    }
  });

  it('connects to the address the policy validated, not a re-resolved hostname (DNS pinning)', async () => {
    // "pinned.test" does not exist in real DNS; the injected resolver maps it to
    // loopback exactly once. A successful response proves the proxy used the
    // validated address and did not perform its own lookup.
    let lookups = 0;
    const policy = new EgressPolicy({
      allowedHosts: [],
      allowedLocalOrigins: [`http://pinned.test:${upstreamPort}`],
      resolve: async () => {
        lookups += 1;
        return [{ address: '127.0.0.1', family: 4 }];
      },
    });
    const proxy = new EgressProxy({ policy });
    const endpoint = await proxy.start();
    try {
      const res = await viaProxy(endpoint, `http://pinned.test:${upstreamPort}/pinned`);
      expect(res).toEqual({ status: 200, body: 'upstream:/pinned' });
      expect(lookups).toBe(1);
      expect(seenHostHeaders.at(-1)).toBe(`pinned.test:${upstreamPort}`); // original Host header preserved
    } finally {
      await proxy.close();
    }
  });

  it('blocks a hostname whose DNS answer changes to a private address (rebinding)', async () => {
    const answers = ['93.184.216.34', '127.0.0.1'];
    const blocked: BlockedConnection[] = [];
    const policy = new EgressPolicy({
      allowedHosts: [],
      allowedLocalOrigins: [],
      resolve: async () => [{ address: answers.shift() ?? '127.0.0.1', family: 4 }],
    });
    // First check (e.g. start_investigation) sees a public address...
    expect((await policy.checkUrl('http://rebind.test/')).allowed).toBe(true);
    // ...but the browser's actual connection is re-validated by the proxy and refused.
    const proxy = new EgressProxy({ policy, onBlocked: (e) => blocked.push(e) });
    const endpoint = await proxy.start();
    try {
      const res = await viaProxy(endpoint, 'http://rebind.test/');
      expect(res.status).toBe(403);
      expect(blocked[0]).toMatchObject({ hostname: 'rebind.test', reason: 'blocked_address' });
    } finally {
      await proxy.close();
    }
  });

  it('reports unresolvable hosts as upstream failures, not policy blocks', async () => {
    const blocked: BlockedConnection[] = [];
    const policy = new EgressPolicy({
      allowedHosts: [],
      allowedLocalOrigins: [],
      resolve: async () => {
        throw new Error('ENOTFOUND');
      },
    });
    const proxy = new EgressProxy({ policy, onBlocked: (e) => blocked.push(e) });
    const endpoint = await proxy.start();
    try {
      const res = await viaProxy(endpoint, 'http://gone.example.com/');
      expect(res.status).toBe(502);
      expect(await connectVia(endpoint, 'gone.example.com:443')).toMatch(/^HTTP\/1.1 502/);
      expect(blocked).toEqual([]);
    } finally {
      await proxy.close();
    }
  });

  it('stops accepting connections after close', async () => {
    const proxy = new EgressProxy({
      policy: new EgressPolicy({ allowedHosts: [], allowedLocalOrigins: [] }),
    });
    const endpoint = await proxy.start();
    await proxy.close();
    await expect(viaProxy(endpoint, 'http://example.com/')).rejects.toThrow();
  });
});
