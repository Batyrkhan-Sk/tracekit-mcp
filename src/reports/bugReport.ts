import os from 'node:os';
import { z } from 'zod';
import type { Analysis, SymptomClass } from '../diagnosis/types.js';
import { AnalysisSchema, UNTRUSTED_NOTICE } from '../diagnosis/types.js';
import { summarizeEvidence } from '../evidence/summarize.js';
import type { InvestigationRecord } from '../investigations/record.js';
import { InvestigationStateSchema, StepStatusSchema } from '../types/investigation.js';
import { SERVER_NAME, SERVER_VERSION } from '../version.js';

export const BugReportSchema = z.object({
  reportVersion: z.literal(1),
  investigationId: z.string(),
  title: z.string(),
  generatedAt: z.string(),
  status: z.object({
    investigationState: InvestigationStateSchema,
    reproductionStatus: z.enum(['reproduced', 'not_reproduced', 'inconclusive']),
    reproductionBasis: z.string(),
  }),
  environment: z.object({
    browser: z.object({ name: z.string(), version: z.string(), userAgent: z.string() }).nullable(),
    viewport: z.object({ width: z.number(), height: z.number() }),
    investigator: z.object({ name: z.string(), version: z.string() }),
    host: z.object({ platform: z.string(), release: z.string(), node: z.string() }),
    startedAt: z.string(),
    endedAt: z.string().optional(),
  }),
  preconditions: z.array(z.string()),
  issueDescription: z.string(),
  reproductionSteps: z.object({
    reported: z.array(z.string()),
    executed: z.array(
      z.object({
        index: z.number().int(),
        description: z.string(),
        status: StepStatusSchema,
        durationMs: z.number(),
        error: z.string().optional(),
        evidenceId: z.string().optional(),
      }),
    ),
  }),
  expectedBehavior: z.object({ text: z.string(), source: z.enum(['provided', 'inferred', 'unknown']) }),
  actualBehavior: z.object({ statements: z.array(z.string()), factIds: z.array(z.string()) }),
  evidence: z.object({
    console: z.array(
      z.object({
        evidenceId: z.string(),
        elapsedMs: z.number(),
        level: z.string(),
        text: z.string(),
        repeatCount: z.number(),
      }),
    ),
    pageErrors: z.array(
      z.object({ evidenceId: z.string(), elapsedMs: z.number(), name: z.string(), message: z.string() }),
    ),
    network: z.array(
      z.object({
        evidenceId: z.string(),
        elapsedMs: z.number(),
        method: z.string(),
        url: z.string(),
        status: z.number().optional(),
        error: z.string().optional(),
        durationMs: z.number().optional(),
        blockedByInvestigator: z.boolean(),
      }),
    ),
    security: z.array(z.object({ evidenceId: z.string(), elapsedMs: z.number(), summary: z.string() })),
    countsByType: z.record(z.string(), z.number()),
    droppedByType: z.record(z.string(), z.number()),
  }),
  keyTimestamps: z.array(
    z.object({ evidenceId: z.string(), elapsedMs: z.number(), timestamp: z.string(), event: z.string() }),
  ),
  screenshots: z.array(
    z.object({
      evidenceId: z.string(),
      file: z.string(),
      absolutePath: z.string(),
      label: z.string().optional(),
      trigger: z.string(),
      elapsedMs: z.number(),
    }),
  ),
  analysis: AnalysisSchema.pick({
    observedFacts: true,
    candidateRootCauses: true,
    additionalExperiments: true,
    methodNote: true,
  }),
  confidenceAndLimitations: z.object({ overall: z.string(), limitations: z.array(z.string()) }),
  suggestedNextSteps: z.array(z.string()),
  untrustedContentNotice: z.string(),
  exportPath: z.string().optional(),
});
export type BugReport = z.infer<typeof BugReportSchema>;

const EXPECTED_BY_SYMPTOM: Record<SymptomClass, string> = {
  loading_flicker:
    'Once content is displayed, the loading placeholder should not re-appear and the page should not flicker.',
  missing_content:
    'Content (or a loading state) should be visible at all times; the page should never be blank while data loads.',
  js_error: 'No uncaught JavaScript errors should occur.',
  network_failure:
    'Required requests should succeed, or failures should be handled with a visible error state.',
  slow_loading: 'The page should become usable within an acceptable time.',
};

const FACT_CATEGORIES_BY_SYMPTOM: Record<SymptomClass, string[]> = {
  loading_flicker: ['visibility', 'layout'],
  missing_content: ['visibility', 'network', 'runtime-error'],
  js_error: ['runtime-error', 'console'],
  network_failure: ['network'],
  slow_loading: ['network'],
};

const KEY_EVENT_TYPES = new Set([
  'navigation',
  'dom_visibility',
  'page_error',
  'network_failure',
  'action',
  'security',
  'screenshot',
]);

export function buildBugReport(record: InvestigationRecord, analysis: Analysis, now = new Date()): BugReport {
  const timeline = record.store.timeline();
  const repro = analysis.reproduction;
  const statusLabel = {
    reproduced: 'Reproduced',
    not_reproduced: 'Not reproduced',
    inconclusive: 'Inconclusive',
  }[repro.status];
  const firstSentence = record.issueDescription.split(/(?<=[.!?])\s/)[0] ?? record.issueDescription;

  const expected = record.expectedBehavior
    ? { text: record.expectedBehavior, source: 'provided' as const }
    : repro.inferredSymptoms.length
      ? {
          text: repro.inferredSymptoms.map((s) => EXPECTED_BY_SYMPTOM[s]).join(' '),
          source: 'inferred' as const,
        }
      : {
          text: 'Not provided and could not be inferred from the issue description.',
          source: 'unknown' as const,
        };

  const relevantCategories = new Set(
    (repro.matchedSymptoms.length ? repro.matchedSymptoms : repro.inferredSymptoms).flatMap(
      (s) => FACT_CATEGORIES_BY_SYMPTOM[s],
    ),
  );
  const actualFacts =
    repro.status === 'reproduced'
      ? analysis.observedFacts.filter((f) => relevantCategories.has(f.category))
      : [];
  const actualStatements = actualFacts.length
    ? actualFacts.map((f) => f.statement)
    : [
        repro.status === 'not_reproduced'
          ? 'The reported behaviour was not observed during this investigation.'
          : 'It could not be determined whether the reported behaviour occurred (see reproduction basis).',
      ];

  const network = timeline
    .filter((i) => i.type === 'network_response' || i.type === 'network_failure')
    .slice(0, 60)
    .map((i) =>
      i.type === 'network_response'
        ? {
            evidenceId: i.id,
            elapsedMs: i.elapsedMs,
            method: i.details.method,
            url: i.url ?? '',
            status: i.details.status,
            ...(i.details.durationMs !== undefined ? { durationMs: i.details.durationMs } : {}),
            blockedByInvestigator: i.details.blockedByInvestigator,
          }
        : i.type === 'network_failure'
          ? {
              evidenceId: i.id,
              elapsedMs: i.elapsedMs,
              method: i.details.method,
              url: i.url ?? '',
              error: i.details.errorText,
              ...(i.details.durationMs !== undefined ? { durationMs: i.details.durationMs } : {}),
              blockedByInvestigator: i.details.blockedByInvestigator,
            }
          : null,
    )
    .filter((x) => x !== null);

  const top = analysis.candidateRootCauses[0];
  const overall = top
    ? `Leading hypothesis "${top.title}" has ${top.confidence.level} confidence: ${top.confidence.explanation}`
    : 'No candidate root cause was identified from the collected evidence.';

  return {
    reportVersion: 1,
    investigationId: record.id,
    title: `[${statusLabel}] ${firstSentence.slice(0, 120)}`,
    generatedAt: now.toISOString(),
    status: {
      investigationState: record.state,
      reproductionStatus: repro.status,
      reproductionBasis: repro.basis,
    },
    environment: {
      browser: record.browserInfo
        ? {
            name: record.browserInfo.name,
            version: record.browserInfo.version,
            userAgent: record.browserInfo.userAgent,
          }
        : null,
      viewport: record.viewport,
      investigator: { name: SERVER_NAME, version: SERVER_VERSION },
      host: { platform: os.platform(), release: os.release(), node: process.version },
      startedAt: new Date(record.createdAtMs).toISOString(),
      ...(record.endedAtMs ? { endedAt: new Date(record.endedAtMs).toISOString() } : {}),
    },
    preconditions: [
      `Target URL: ${record.targetUrl}`,
      `Viewport ${record.viewport.width}×${record.viewport.height}, headless Chromium.`,
      'Fresh isolated browser context: no cookies, storage, cache or service workers from previous sessions.',
      'Outbound traffic restricted by the investigator egress policy (private-network protection; state-changing requests blocked unless enabled).',
      ...(record.watch.loading.length || record.watch.content.length
        ? [
            `Watched selectors - loading: ${record.watch.loading.join(', ') || 'none'}; content: ${record.watch.content.join(', ') || 'none'}.`,
          ]
        : []),
    ],
    issueDescription: record.issueDescription,
    reproductionSteps: {
      reported: record.reportedSteps,
      executed: record.steps.map(({ outcome }) => ({
        index: outcome.index,
        description: outcome.description,
        status: outcome.status,
        durationMs: outcome.durationMs,
        ...(outcome.error ? { error: outcome.error } : {}),
        ...(outcome.evidenceId ? { evidenceId: outcome.evidenceId } : {}),
      })),
    },
    expectedBehavior: expected,
    actualBehavior: { statements: actualStatements, factIds: actualFacts.map((f) => f.id) },
    evidence: {
      console: record.store
        .ofType('console')
        .slice(0, 50)
        .map((c) => ({
          evidenceId: c.id,
          elapsedMs: c.elapsedMs,
          level: c.details.level,
          text: c.details.text,
          repeatCount: c.details.repeatCount,
        })),
      pageErrors: record.store
        .ofType('page_error')
        .slice(0, 30)
        .map((e) => ({
          evidenceId: e.id,
          elapsedMs: e.elapsedMs,
          name: e.details.name,
          message: e.details.message,
        })),
      network,
      security: record.store
        .ofType('security')
        .slice(0, 30)
        .map((s) => ({ evidenceId: s.id, elapsedMs: s.elapsedMs, summary: summarizeEvidence(s) })),
      countsByType: record.store.counts(),
      droppedByType: record.store.dropped() as Record<string, number>,
    },
    keyTimestamps: timeline
      .filter(
        (i) =>
          KEY_EVENT_TYPES.has(i.type) &&
          !(i.type === 'dom_visibility' && i.details.heuristic && record.watch.loading.length),
      )
      .slice(0, 80)
      .map((i) => ({
        evidenceId: i.id,
        elapsedMs: i.elapsedMs,
        timestamp: i.timestamp,
        event: summarizeEvidence(i),
      })),
    screenshots: record.store.ofType('screenshot').map((s) => ({
      evidenceId: s.id,
      file: s.details.file,
      absolutePath: s.details.absolutePath,
      ...(s.details.label ? { label: s.details.label } : {}),
      trigger: s.details.trigger,
      elapsedMs: s.elapsedMs,
    })),
    analysis: {
      methodNote: analysis.methodNote,
      observedFacts: analysis.observedFacts,
      candidateRootCauses: analysis.candidateRootCauses,
      additionalExperiments: analysis.additionalExperiments,
    },
    confidenceAndLimitations: { overall, limitations: analysis.limitations },
    suggestedNextSteps: [
      ...analysis.additionalExperiments,
      ...(repro.status !== 'reproduced'
        ? []
        : [
            'Use generate_regression_test to capture the observed behaviour as a Playwright test, then review it.',
          ]),
    ],
    untrustedContentNotice: UNTRUSTED_NOTICE,
  };
}
