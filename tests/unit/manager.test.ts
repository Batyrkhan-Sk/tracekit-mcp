import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InvestigationManager } from '../../src/investigations/manager.js';
import { EgressPolicy } from '../../src/security/egressPolicy.js';
import type { InvestigatorConfig } from '../../src/config/config.js';
import { InvestigatorError } from '../../src/util/errors.js';
import { silentLogger } from '../../src/util/logger.js';
import { testConfig } from '../helpers/config.js';
import { fakeSessionFactory, publicResolver, type FakeBehaviour } from '../helpers/fakeSession.js';

const managers: InvestigationManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.dispose({ removeArtifacts: true })));
});

function setup(config: Partial<InvestigatorConfig> = {}, behaviour: FakeBehaviour = {}) {
  const cfg = testConfig(config);
  const { factory, sessions } = fakeSessionFactory(behaviour);
  const manager = new InvestigationManager({
    config: cfg,
    policy: new EgressPolicy({ allowedHosts: [], allowedLocalOrigins: [], resolve: publicResolver }),
    createSession: factory,
    logger: silentLogger,
  });
  managers.push(manager);
  return { manager, sessions, config: cfg };
}

const start = (manager: InvestigationManager, extra: object = {}) =>
  manager.start({
    targetUrl: 'https://shop.example.com/catalog?token=abc',
    issueDescription: 'flicker on load',
    ...extra,
  });

async function expectCode(promise: Promise<unknown> | (() => unknown), code: string) {
  try {
    await (typeof promise === 'function' ? promise() : promise);
  } catch (error) {
    expect(error).toBeInstanceOf(InvestigatorError);
    expect((error as InvestigatorError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe('InvestigationManager lifecycle', () => {
  it('starts an investigation, navigates, and becomes ready', async () => {
    const { manager, sessions } = setup();
    const result = await start(manager);
    expect(result.investigationId).toMatch(/^inv_/);
    expect(result.state).toBe('ready');
    expect(result.navigation.ok).toBe(true);
    expect(result.targetUrl).toContain('token=[REDACTED]');
    expect(sessions[0]!.navigations).toEqual(['https://shop.example.com/catalog?token=abc']);
    const stat = await fs.stat(result.artifactsDir);
    expect(stat.isDirectory()).toBe(true);
  });

  it('rejects disallowed target URLs before creating a browser session', async () => {
    const { manager, sessions } = setup();
    await expectCode(
      manager.start({ targetUrl: 'http://169.254.169.254/', issueDescription: 'x' }),
      'URL_REJECTED',
    );
    await expectCode(
      manager.start({ targetUrl: 'file:///etc/passwd', issueDescription: 'x' }),
      'URL_REJECTED',
    );
    expect(sessions).toHaveLength(0);
  });

  it('enforces the server duration limit', async () => {
    const { manager } = setup({ maxDurationSeconds: 60 });
    await expectCode(start(manager, { maxDurationSeconds: 61 }), 'INVALID_INPUT');
  });

  it('limits concurrent investigations and frees a slot on close', async () => {
    const { manager, sessions } = setup({ maxConcurrentInvestigations: 1 });
    const first = await start(manager);
    await expectCode(start(manager), 'LIMIT_REACHED');
    const closed = await manager.close(first.investigationId);
    expect(closed.state).toBe('closed');
    expect(sessions[0]!.closed).toBe(true);
    await expect(start(manager)).resolves.toMatchObject({ state: 'ready' });
  });

  it('keeps evidence after close but refuses new steps', async () => {
    const { manager } = setup();
    const { investigationId } = await start(manager);
    await manager.close(investigationId);
    await expectCode(manager.reproduce(investigationId, [{ action: 'reload' }]), 'INVALID_STATE');
    expect((await manager.collect(investigationId)).items.length).toBeGreaterThan(0);
    expect(manager.analyze(investigationId).investigationId).toBe(investigationId);
    // Closing twice is idempotent.
    await expect(manager.close(investigationId)).resolves.toMatchObject({ state: 'closed' });
  });

  it('rejects unknown and malformed investigation ids', async () => {
    const { manager } = setup();
    await expectCode(() => manager.get('inv_00000000-0000-4000-8000-000000000000'), 'NOT_FOUND');
    await expectCode(() => manager.get('../../etc'), 'INVALID_INPUT');
  });

  it('rejects concurrent reproduction on the same investigation', async () => {
    const { manager } = setup({}, { stepDelayMs: 100 });
    const { investigationId } = await start(manager);
    const first = manager.reproduce(investigationId, [{ action: 'reload' }]);
    await expectCode(manager.reproduce(investigationId, [{ action: 'reload' }]), 'BUSY');
    await expect(first).resolves.toMatchObject({ state: 'ready', summary: { succeeded: 1 } });
  });

  it('skips remaining steps after a failure unless continueOnFailure is set', async () => {
    const { manager } = setup();
    const { investigationId } = await start(manager);
    const steps = [
      { action: 'waitFor' as const, target: { by: 'testId' as const, testId: 'missing' }, timeoutMs: 200 },
      { action: 'reload' as const },
    ];
    const stopped = await manager.reproduce(investigationId, steps);
    expect(stopped.steps.map((s) => s.status)).toEqual(['timed_out', 'skipped']);
    expect(stopped.steps[1]!.error).toMatch(/step #1 timed_out/);
    const continued = await manager.reproduce(investigationId, steps, { continueOnFailure: true });
    expect(continued.steps.map((s) => s.status)).toEqual(['timed_out', 'succeeded']);
    expect(continued.steps[0]!.index).toBe(3); // step indexes continue across calls
  });

  it('expires at the deadline and releases the browser session', async () => {
    const { manager, sessions } = setup();
    const { investigationId } = await start(manager, { maxDurationSeconds: 0.3 });
    await new Promise((r) => setTimeout(r, 450));
    expect(manager.get(investigationId).state).toBe('expired');
    expect(sessions[0]!.closed).toBe(true);
    await expectCode(manager.reproduce(investigationId, [{ action: 'reload' }]), 'INVALID_STATE');
  });

  it('marks the investigation failed and cleans up when the browser cannot start', async () => {
    const { manager } = setup({}, { failCreate: true });
    await expectCode(start(manager), 'BROWSER_ERROR');
    const [entry] = manager.list();
    expect(entry!.state).toBe('failed');
  });

  it('reports navigation failures without failing the investigation', async () => {
    const { manager } = setup({}, { failNavigationFor: 'shop.example.com' });
    const result = await start(manager);
    expect(result.state).toBe('ready');
    expect(result.navigation).toMatchObject({
      ok: false,
      error: expect.stringContaining('ERR_CONNECTION_REFUSED'),
    });
  });

  it('evicts the oldest finished investigations at the retention cap, including artifacts', async () => {
    const { manager } = setup({ maxRetainedInvestigations: 2, maxConcurrentInvestigations: 2 });
    const a = await start(manager);
    await manager.close(a.investigationId);
    const b = await start(manager);
    await manager.close(b.investigationId);
    await start(manager);
    expect(manager.list().map((r) => r.id)).not.toContain(a.investigationId);
    await expect(fs.stat(a.artifactsDir)).rejects.toThrow();
  });

  it('purges finished investigations after the retention period', async () => {
    const { manager } = setup({ retentionSeconds: 0 });
    const { investigationId } = await start(manager);
    await manager.close(investigationId);
    await manager.sweep();
    await expectCode(() => manager.get(investigationId), 'NOT_FOUND');
  });

  it('removes stale artifact directories from earlier runs, and nothing else', async () => {
    const { manager, config } = setup({ retentionSeconds: 0 });
    const stale = path.join(config.artifactsDir, 'inv_11111111-1111-4111-8111-111111111111');
    const unrelated = path.join(config.artifactsDir, 'keep-me');
    await fs.mkdir(stale, { recursive: true });
    await fs.mkdir(unrelated, { recursive: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(await manager.cleanupStaleArtifacts()).toBe(1);
    await expect(fs.stat(stale)).rejects.toThrow();
    await expect(fs.stat(unrelated)).resolves.toBeTruthy();
  });

  it('closes every session on dispose and refuses new work', async () => {
    const { manager, sessions } = setup();
    await start(manager);
    await manager.dispose();
    expect(sessions.every((s) => s.closed)).toBe(true);
    await expectCode(start(manager), 'INVALID_STATE');
  });

  it('exports the bug report as JSON', async () => {
    const { manager } = setup();
    const { investigationId } = await start(manager);
    const report = await manager.report(investigationId);
    const exported = JSON.parse(await fs.readFile(report.exportPath!, 'utf8'));
    expect(exported.investigationId).toBe(investigationId);
  });
});
