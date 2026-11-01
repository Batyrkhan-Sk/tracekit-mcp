import { describe, expect, it } from 'vitest';
import { analyzeEvidence } from '../../src/diagnosis/analyzer.js';
import type { InvestigationRecord } from '../../src/investigations/record.js';
import { BugReportSchema, buildBugReport } from '../../src/reports/bugReport.js';
import { generateRegressionTest, RegressionTestSchema } from '../../src/reports/regressionTest.js';
import type { Action } from '../../src/types/actions.js';
import { CONTENT, flickerTimeline, LOADER, TimelineBuilder } from '../helpers/timeline.js';

const ISSUE = 'After refreshing the catalog page, a loading placeholder briefly covers the content.';

function recordFrom(t: TimelineBuilder, overrides: Partial<InvestigationRecord> = {}): InvestigationRecord {
  const steps: { action: Action; status: 'succeeded' | 'failed' }[] = [
    { action: { action: 'reload' }, status: 'succeeded' },
    { action: { action: 'waitFor', target: { by: 'testId', testId: 'catalog-grid' } }, status: 'succeeded' },
    {
      action: { action: 'click', target: { by: 'role', role: 'button', name: "Don't panic" } },
      status: 'succeeded',
    },
    {
      action: { action: 'fill', target: { by: 'label', label: 'Password' }, value: 'hunter2' },
      status: 'succeeded',
    },
    {
      action: { action: 'fill', target: { by: 'placeholder', placeholder: 'Search' }, value: 'mug' },
      status: 'succeeded',
    },
    { action: { action: 'click', target: { by: 'text', text: 'Broken' } }, status: 'failed' },
    { action: { action: 'screenshot' }, status: 'succeeded' },
  ];
  return {
    id: t.store.investigationId,
    state: 'ready',
    createdAtMs: 1_700_000_000_000,
    deadlineAtMs: 1_700_000_300_000,
    targetUrl: 'http://127.0.0.1:4173/catalog?session=[REDACTED]',
    issueDescription: ISSUE,
    reportedSteps: ['Open the catalog', 'Refresh'],
    viewport: { width: 1280, height: 800 },
    watch: { loading: [LOADER], content: [CONTENT], heuristics: true },
    waitUntil: 'load',
    store: t.store,
    session: null,
    steps: steps.map((s, i) => ({
      action: s.action,
      outcome: {
        index: i + 1,
        action: s.action.action,
        description: s.action.action,
        status: s.status,
        durationMs: 5,
        finalUrl: '',
      },
    })),
    initialNavigation: {
      ok: true,
      status: 200,
      finalUrl: 'http://127.0.0.1:4173/catalog',
      durationMs: 40,
      blockedByPolicy: false,
    },
    browserInfo: {
      name: 'chromium',
      version: '140.0',
      userAgent: 'UA',
      viewport: { width: 1280, height: 800 },
    },
    artifactsDir: '/tmp/x',
    ...overrides,
  };
}

function analysisFor(record: InvestigationRecord) {
  return analyzeEvidence({
    investigationId: record.id,
    issueDescription: record.issueDescription,
    timeline: record.store.timeline(),
    steps: record.steps.map((s) => s.outcome),
    state: record.state,
    droppedByType: record.store.dropped(),
    watch: record.watch,
    initialNavigation: record.initialNavigation,
  });
}

describe('buildBugReport', () => {
  it('produces a schema-valid report that separates facts, hypotheses and limitations', () => {
    const record = recordFrom(flickerTimeline());
    const report = buildBugReport(record, analysisFor(record), new Date('2026-01-01T00:00:00Z'));
    expect(() => BugReportSchema.parse(report)).not.toThrow();
    expect(report.title).toMatch(/^\[Reproduced\]/);
    expect(report.status.reproductionStatus).toBe('reproduced');
    expect(report.expectedBehavior.source).toBe('inferred');
    expect(report.actualBehavior.statements.join(' ')).toMatch(/became visible again/);
    expect(report.analysis.candidateRootCauses[0]!.hypothesis).toBeTruthy();
    expect(report.confidenceAndLimitations.limitations.length).toBeGreaterThan(0);
    expect(report.reproductionSteps.reported).toEqual(['Open the catalog', 'Refresh']);
    expect(report.reproductionSteps.executed).toHaveLength(7);
    expect(report.environment.browser?.version).toBe('140.0');
    expect(report.keyTimestamps.length).toBeGreaterThan(0);
  });

  it('uses the provided expected behaviour and does not claim reproduction without evidence', () => {
    const t = new TimelineBuilder();
    t.at(0).navigate();
    const record = recordFrom(t, { expectedBehavior: 'No placeholder after content', steps: [] });
    const report = buildBugReport(record, analysisFor(record));
    expect(report.expectedBehavior).toEqual({ text: 'No placeholder after content', source: 'provided' });
    expect(report.status.reproductionStatus).not.toBe('reproduced');
    expect(report.actualBehavior.statements[0]).toMatch(/not observed|could not be determined/);
  });
});

describe('generateRegressionTest', () => {
  it('generates a reviewable Playwright test for the observed flicker', () => {
    const record = recordFrom(flickerTimeline());
    const test = generateRegressionTest(record, analysisFor(record));
    expect(() => RegressionTestSchema.parse(test)).not.toThrow();
    expect(test.executed).toBe(false);
    expect(test.fileName).toMatch(/\.spec\.ts$/);
    expect(test.code).toContain("from '@playwright/test'");
    expect(test.code).toContain("page.getByTestId('catalog-grid')"); // user-visible locator from CSS test id
    expect(test.code).toContain("page.getByRole('button', { name: 'Don\\'t panic' })"); // escaped
    expect(test.code).toContain('checkReappear: true');
    expect(test.code).toContain('expect(violations');
    expect(test.code).not.toMatch(/waitForTimeout|setTimeout\(/); // no arbitrary sleeps
    expect(test.assertions[0]!.derivedFrom.length).toBeGreaterThan(1);
  });

  it('never embeds sensitive fill values and replays only successful steps', () => {
    const record = recordFrom(flickerTimeline());
    const test = generateRegressionTest(record, analysisFor(record));
    expect(test.code).not.toContain('hunter2');
    expect(test.code).toContain('process.env.TEST_INPUT_4');
    expect(test.code).toContain(".fill('mug')");
    expect(test.code).not.toContain("getByText('Broken')");
    expect(test.assumptions.some((a) => /did not succeed/.test(a))).toBe(true);
    expect(test.assumptions.some((a) => /\[REDACTED\]/.test(a))).toBe(true);
  });

  it('neutralises comment terminators in the issue text', () => {
    const record = recordFrom(flickerTimeline(), {
      issueDescription: 'loading flicker */ process.exit(1); /*',
    });
    const test = generateRegressionTest(record, analysisFor(record));
    expect(test.code).not.toContain('*/ process.exit');
  });

  it('falls back to a clearly labelled smoke test when nothing relevant was observed', () => {
    const t = new TimelineBuilder();
    t.at(0).navigate();
    t.at(10).visibility('content', CONTENT, true);
    const record = recordFrom(t);
    const test = generateRegressionTest(record, analysisFor(record));
    expect(test.assertions[0]!.description).toMatch(/Smoke/);
    expect(test.reviewNotes.join(' ')).toMatch(/NOT detect/);
  });

  it('honours a custom test name safely', () => {
    const record = recordFrom(flickerTimeline());
    const test = generateRegressionTest(record, analysisFor(record), { testName: "catalog: it's stable" });
    expect(test.code).toContain("test('catalog: it\\'s stable'");
  });
});
