import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InvestigationManager } from '../../src/investigations/manager.js';
import { startBugApp, type BugApp } from '../fixtures/bugApp.js';
import { realInvestigator, type CountingProvider } from '../helpers/investigator.js';

let app: BugApp;
let other: http.Server;
let otherPort: number;
let manager: InvestigationManager;
let provider: CountingProvider;
let artifactsRoot: string;

beforeAll(async () => {
  app = await startBugApp();
  // A second loopback service that is NOT allowlisted: stands in for an internal service.
  other = http.createServer((_req, res) => res.end('internal secret'));
  await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
  otherPort = (other.address() as AddressInfo).port;
  const inv = realInvestigator({ allowedLocalOrigins: [app.url], defaultActionTimeoutMs: 3000 });
  manager = inv.manager;
  provider = inv.provider;
  artifactsRoot = inv.config.artifactsDir;
});

afterAll(async () => {
  await manager?.dispose({ removeArtifacts: true });
  await app?.close();
  await new Promise<void>((r) => other.close(() => r()));
});

const start = (pathName: string, extra: Record<string, unknown> = {}) =>
  manager.start({ targetUrl: `${app.url}${pathName}`, issueDescription: 'Something is broken', ...extra });

describe('network safety in a real browser', () => {
  it('blocks page navigation to a non-allowlisted loopback service and to cloud metadata', async () => {
    const { investigationId: id } = await start('/clean');
    const run = await manager.reproduce(
      id,
      [
        { action: 'navigate', url: `http://127.0.0.1:${otherPort}/` },
        { action: 'navigate', url: 'http://169.254.169.254/latest/meta-data/' },
        { action: 'navigate', url: 'file:///C:/Windows/win.ini' },
      ],
      { continueOnFailure: true },
    );
    expect(run.steps.map((s) => s.status)).toEqual(['blocked', 'blocked', 'blocked']);
    await manager.close(id);
  });

  it('re-validates redirects: an allowed page redirecting to a private address is blocked', async () => {
    const { investigationId: id } = await start('/clean');
    const run = await manager.reproduce(id, [
      {
        action: 'navigate',
        url: `${app.url}/redirect?to=${encodeURIComponent(`http://127.0.0.1:${otherPort}/`)}`,
      },
    ]);
    expect(run.steps[0]!.status).not.toBe('succeeded');
    const security = (await manager.collect(id, { categories: ['security'] })).items;
    expect(security.some((s) => s.type === 'security' && s.details.port === otherPort)).toBe(true);
    await manager.close(id);
  });

  it('blocks state-changing requests (form POST) by default', async () => {
    const { investigationId: id } = await start('/form');
    const run = await manager.reproduce(id, [
      { action: 'fill', target: { by: 'label', label: 'Name' }, value: 'Ada' },
      { action: 'select', target: { by: 'role', role: 'combobox', name: 'Color' }, option: { value: 'g' } },
      { action: 'click', target: { by: 'role', role: 'button', name: 'Save' } },
    ]);
    expect(run.steps.slice(0, 2).map((s) => s.status)).toEqual(['succeeded', 'succeeded']);
    await new Promise((r) => setTimeout(r, 300));
    const security = (await manager.collect(id, { categories: ['security'] })).items;
    expect(security.some((s) => s.type === 'security' && s.details.kind === 'mutating_request')).toBe(true);
    expect(app.requests.filter((r) => r.startsWith('POST'))).toEqual([]);
    await manager.close(id);
  });

  it('blocks beacons and keepalive DELETE requests sent by page scripts', async () => {
    const before = app.requests.length;
    const { investigationId: id } = await start('/beacon');
    await new Promise((r) => setTimeout(r, 500));
    const security = (await manager.collect(id, { categories: ['security'] })).items;
    expect(
      security.filter((s) => s.type === 'security' && s.details.kind === 'mutating_request').length,
    ).toBe(2);
    expect(app.requests.slice(before).filter((r) => !r.startsWith('GET'))).toEqual([]);
    await manager.close(id);
  });

  it('refuses to click destructive-looking controls', async () => {
    const { investigationId: id } = await start('/form');
    const run = await manager.reproduce(id, [
      { action: 'click', target: { by: 'role', role: 'button', name: 'Delete account' } },
    ]);
    expect(run.steps[0]).toMatchObject({ status: 'blocked' });
    expect(run.steps[0]!.error).toMatch(/destructive/);
    await manager.close(id);
  });

  it('closes popups opened by the page', async () => {
    const { investigationId: id } = await start('/popup');
    await new Promise((r) => setTimeout(r, 300));
    const navs = (await manager.collect(id, { categories: ['navigation'] })).items;
    expect(navs.some((n) => n.type === 'navigation' && n.details.event === 'popup_closed')).toBe(true);
    await manager.close(id);
  });
});

describe('reliability', () => {
  it('records action timeouts, skips later steps, and screenshots the failure', async () => {
    const { investigationId: id } = await start('/clean');
    const run = await manager.reproduce(id, [
      { action: 'waitFor', target: { by: 'testId', testId: 'does-not-exist' }, timeoutMs: 300 },
      { action: 'reload' },
    ]);
    expect(run.steps.map((s) => s.status)).toEqual(['timed_out', 'skipped']);
    expect(run.steps[0]!.error).toMatch(/Timeout/);
    expect(run.steps[0]!.screenshot).toBeDefined();
    await expect(fs.stat(run.steps[0]!.screenshot!.absolutePath)).resolves.toBeTruthy();
    expect(path.resolve(run.steps[0]!.screenshot!.absolutePath).startsWith(path.resolve(artifactsRoot))).toBe(
      true,
    );
    await manager.close(id);
  });

  it('reports a navigation failure without crashing the investigation', async () => {
    // Allowed origin, but nothing listens there.
    const closed = http.createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const inv = realInvestigator({
      allowedLocalOrigins: [`http://127.0.0.1:${port}`],
      defaultActionTimeoutMs: 3000,
    });
    try {
      const result = await inv.manager.start({
        targetUrl: `http://127.0.0.1:${port}/`,
        issueDescription: 'page does not load',
      });
      expect(result.state).toBe('ready');
      expect(result.navigation.ok).toBe(false);
      expect(result.navigation.error).toBeTruthy();
      expect(inv.manager.analyze(result.investigationId).reproduction.status).not.toBe('reproduced');
    } finally {
      await inv.manager.dispose({ removeArtifacts: true });
    }
  });

  it('times out slow navigations within the action timeout', async () => {
    const { investigationId: id } = await start('/clean');
    const run = await manager.reproduce(id, [{ action: 'navigate', url: `${app.url}/slow`, timeoutMs: 500 }]);
    expect(run.steps[0]!.status).toBe('timed_out');
    await manager.close(id);
  });

  it('handles elements detached while waiting', async () => {
    const { investigationId: id } = await start('/placeholder-vanish', {
      watch: { loading: ['[data-testid="loading"]'] },
    });
    // The spinner is hidden by the page after ~100ms; waiting for it to be hidden must succeed.
    const run = await manager.reproduce(id, [
      { action: 'waitFor', target: { by: 'testId', testId: 'loading' }, state: 'hidden' },
    ]);
    expect(run.steps[0]!.status).toBe('succeeded');
    await manager.close(id);
  });

  it('expires at the deadline and releases browser resources', async () => {
    const { investigationId: id } = await start('/clean', { maxDurationSeconds: 1 });
    await new Promise((r) => setTimeout(r, 1500));
    expect(manager.get(id).state).toBe('expired');
    expect(manager.get(id).session).toBeNull();
    // Evidence remains available.
    expect((await manager.collect(id)).items.length).toBeGreaterThan(0);
  });

  it('returns every acquired browser context once investigations end', async () => {
    const ids = [(await start('/clean')).investigationId, (await start('/clean')).investigationId];
    for (const id of ids) await manager.close(id);
    const active = manager.list().filter((r) => r.state === 'ready' || r.state === 'running');
    expect(active).toEqual([]);
    expect(provider.released).toBe(provider.acquired);
  });
});
