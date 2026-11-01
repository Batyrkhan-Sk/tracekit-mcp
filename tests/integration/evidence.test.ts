import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startCatalogServer, type CatalogServer } from '../../examples/faulty-catalog-app/server.js';
import type { InvestigationManager } from '../../src/investigations/manager.js';
import { EvidenceItemSchema } from '../../src/types/evidence.js';
import { startBugApp, type BugApp } from '../fixtures/bugApp.js';
import { realInvestigator } from '../helpers/investigator.js';

let app: BugApp;
let buggy: CatalogServer;
let fixed: CatalogServer;
let manager: InvestigationManager;

beforeAll(async () => {
  app = await startBugApp();
  buggy = await startCatalogServer({ mode: 'buggy' });
  fixed = await startCatalogServer({ mode: 'fixed' });
  ({ manager } = realInvestigator({ allowedLocalOrigins: [app.url, buggy.url, fixed.url] }));
});

afterAll(async () => {
  await manager?.dispose({ removeArtifacts: true });
  await Promise.all([app?.close(), buggy?.close(), fixed?.close()]);
});

async function investigate(path: string, issueDescription: string, extra: Record<string, unknown> = {}) {
  const started = await manager.start({
    targetUrl: `${app.url}${path}`,
    issueDescription,
    waitUntil: 'networkidle',
    ...extra,
  });
  return started.investigationId;
}

describe('evidence capture against the bug fixture app', () => {
  it('captures nothing anomalous on a clean page and does not invent causes', async () => {
    const id = await investigate('/clean', 'Uncaught JavaScript error when opening the page');
    await manager.reproduce(id, [{ action: 'reload', waitUntil: 'networkidle' }]);
    const { items } = await manager.collect(id, { limit: 200 });
    for (const item of items) expect(() => EvidenceItemSchema.parse(item)).not.toThrow();
    expect(
      items.filter((i) => i.type === 'page_error' || i.type === 'console' || i.type === 'network_failure'),
    ).toEqual([]);
    expect(items.filter((i) => i.type === 'network_response' && !i.details.ok)).toEqual([]);
    expect(items.some((i) => i.type === 'network_response' && i.url?.endsWith('/api/ok'))).toBe(true);

    const analysis = manager.analyze(id);
    expect(analysis.candidateRootCauses).toEqual([]);
    expect(analysis.reproduction.status).toBe('not_reproduced');
    await manager.close(id);
  });

  it('captures an uncaught JavaScript error', async () => {
    const id = await investigate('/js-error', 'The widget crashes with a TypeError');
    const errors = (await manager.collect(id, { categories: ['page_error'] })).items;
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ type: 'page_error', untrusted: true, details: { name: 'TypeError' } });
    expect(JSON.stringify(errors[0])).toContain("reading 'title'");

    const analysis = manager.analyze(id);
    expect(analysis.reproduction.status).toBe('reproduced');
    expect(analysis.candidateRootCauses[0]!.kind).toBe('uncaught_exception');
    await manager.close(id);
  });

  it('captures failed API requests with their status codes', async () => {
    const id = await investigate('/failed-api', 'The data API request fails');
    const responses = (await manager.collect(id, { categories: ['network_response'] })).items.filter(
      (i) => i.type === 'network_response' && !i.details.ok,
    );
    const statuses = Object.fromEntries(
      responses.map((r) => [new URL(r.url!).pathname, r.type === 'network_response' ? r.details.status : 0]),
    );
    expect(statuses).toEqual({ '/api/missing': 404, '/api/broken': 500 });
    const kinds = manager.analyze(id).candidateRootCauses.map((c) => c.kind);
    expect(kinds.filter((k) => k === 'failed_request')).toHaveLength(2);
    expect(kinds).not.toContain('uncaught_exception');
    await manager.close(id);
  });

  it('detects a loading placeholder that disappears before the content is ready', async () => {
    const id = await investigate(
      '/placeholder-vanish',
      'The list area is blank for a while after the spinner disappears',
      {
        watch: { loading: ['[data-testid="loading"]'], content: ['[data-testid="content"]'] },
      },
    );
    await manager.reproduce(id, [{ action: 'waitFor', target: { by: 'testId', testId: 'content' } }]);
    const analysis = manager.analyze(id);
    expect(analysis.reproduction.status).toBe('reproduced');
    const cause = analysis.candidateRootCauses.find((c) => c.kind === 'premature_loader_removal');
    expect(cause).toBeDefined();
    expect(
      analysis.observedFacts.some((f) => /removed at .* but content only became visible/.test(f.statement)),
    ).toBe(true);
    expect(analysis.candidateRootCauses.some((c) => c.kind === 'loading_state_reentered')).toBe(false);
    await manager.close(id);
  });

  it('detects UI flicker caused by a delayed response', async () => {
    const id = await investigate('/flicker', 'The loading indicator flickers after the content appeared', {
      watch: { loading: ['[data-testid="loading"]'], content: ['[data-testid="content"]'] },
    });
    const analysis = manager.analyze(id);
    expect(analysis.reproduction.status).toBe('reproduced');
    const cause = analysis.candidateRootCauses[0]!;
    expect(cause.kind).toBe('loading_state_reentered');
    expect(cause.supportingEvidence.map((s) => s.note).join(' ')).toContain('/api/delayed');
    await manager.close(id);
  });

  it('redacts secrets and flags prompt-injection text from the page', async () => {
    const id = await investigate('/secrets', 'Console errors on load');
    const { items } = await manager.collect(id, { limit: 200 });
    const serialized = JSON.stringify(items);
    expect(serialized).not.toContain('supersecret123');
    expect(serialized).not.toContain('jane@example.com');
    expect(serialized).not.toContain('abcdefghijklmnop');
    expect(serialized).toContain('access_token=[REDACTED]');
    const warning = items.find((i) => i.type === 'console' && i.details.level === 'warning');
    expect(warning).toMatchObject({ untrusted: true, details: { possiblePromptInjection: true } });
    const report = await manager.report(id);
    expect(JSON.stringify(report)).not.toContain('supersecret123');
    await manager.close(id);
  });
});

describe('faulty catalog demo app', () => {
  const issue =
    'After refreshing the catalog page, a loading placeholder briefly covers the content, and the page flickers before stabilizing.';
  const watch = { loading: ['[data-testid="catalog-loading"]'], content: ['[data-testid="catalog-grid"]'] };

  it('reproduces the flicker in buggy mode', async () => {
    const { investigationId: id } = await manager.start({
      targetUrl: `${buggy.url}/catalog`,
      issueDescription: issue,
      watch,
      waitUntil: 'networkidle',
    });
    const run = await manager.reproduce(id, [{ action: 'reload', waitUntil: 'networkidle' }]);
    expect(run.summary.succeeded).toBe(1);
    const analysis = manager.analyze(id);
    expect(analysis.reproduction.status).toBe('reproduced');
    expect(analysis.candidateRootCauses[0]).toMatchObject({
      kind: 'loading_state_reentered',
      confidence: { level: 'medium' },
    });
    // The unrelated 404 is reported, but ranked below the flicker and with contradicting evidence.
    const banner = analysis.candidateRootCauses.find((c) => c.title.includes('/api/banner'));
    expect(banner?.confidence.level).toBe('low');
    expect(banner?.contradictingEvidence.length).toBeGreaterThan(0);

    const test = manager.regressionTest(id);
    expect(test.code).toContain('checkReappear: true');
    await manager.close(id);
  });

  it('does not report a flicker in fixed mode', async () => {
    const { investigationId: id } = await manager.start({
      targetUrl: `${fixed.url}/catalog`,
      issueDescription: issue,
      watch,
      waitUntil: 'networkidle',
    });
    await manager.reproduce(id, [{ action: 'reload', waitUntil: 'networkidle' }]);
    const analysis = manager.analyze(id);
    expect(analysis.candidateRootCauses.some((c) => c.kind === 'loading_state_reentered')).toBe(false);
    expect(analysis.reproduction.status).toBe('not_reproduced');
    await manager.close(id);
  });
});
