import { z } from 'zod';
import { AnalysisSchema } from '../diagnosis/types.js';
import { INVESTIGATION_ID_PATTERN } from '../investigations/manager.js';
import { BugReportSchema } from '../reports/bugReport.js';
import { RegressionTestSchema } from '../reports/regressionTest.js';
import { ActionSchema, CssSelector } from '../types/actions.js';
import { EvidenceItemSchema, EvidenceTypeSchema } from '../types/evidence.js';
import {
  InvestigationStateSchema,
  NavigationOutcomeSchema,
  ScreenshotRefSchema,
  StepOutcomeSchema,
} from '../types/investigation.js';

export const InvestigationId = z
  .string()
  .regex(INVESTIGATION_ID_PATTERN, 'Expected an id returned by start_investigation (inv_<uuid>)')
  .describe('Id returned by start_investigation');

const counts = z.record(z.string(), z.number());

// ---- start_investigation ----

export const StartInvestigationInput = z.strictObject({
  targetUrl: z.string().min(1).max(2048).describe('http(s) URL of the page to investigate'),
  issueDescription: z.string().min(1).max(4000).describe('Natural-language description of the suspected bug'),
  stepsToReproduce: z
    .array(z.string().min(1).max(500))
    .max(50)
    .optional()
    .describe(
      'Human-written reproduction steps (recorded in the report; use reproduce_issue to execute actions)',
    ),
  expectedBehavior: z.string().max(2000).optional().describe('What should happen instead, if known'),
  maxDurationSeconds: z
    .number()
    .int()
    .min(10)
    .max(3600)
    .optional()
    .describe('Hard deadline for the whole investigation'),
  viewport: z
    .strictObject({ width: z.number().int().min(320).max(3840), height: z.number().int().min(240).max(2160) })
    .optional(),
  watch: z
    .strictObject({
      loading: z
        .array(CssSelector)
        .max(10)
        .optional()
        .describe('CSS selectors of loading placeholders/spinners'),
      content: z
        .array(CssSelector)
        .max(10)
        .optional()
        .describe('CSS selectors of the main content that should appear'),
      heuristics: z
        .boolean()
        .optional()
        .describe(
          'Also track common loading-indicator patterns (aria-busy, progressbar, *loading*, *skeleton*). Default true',
        ),
    })
    .optional()
    .describe(
      'Elements whose visibility is tracked over time; needed to observe flicker and placeholder bugs',
    ),
  waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle', 'commit']).optional(),
});

export const StartInvestigationOutput = z.object({
  investigationId: z.string(),
  state: InvestigationStateSchema,
  targetUrl: z.string(),
  navigation: NavigationOutcomeSchema,
  screenshot: ScreenshotRefSchema.optional(),
  deadline: z.string(),
  artifactsDir: z.string(),
  browser: z.object({ name: z.string(), version: z.string() }),
  evidenceCounts: counts,
});

// ---- reproduce_issue ----

export const ReproduceIssueInput = z.strictObject({
  investigationId: InvestigationId,
  steps: z.array(ActionSchema).min(1).max(50).describe('Ordered browser actions'),
  continueOnFailure: z.boolean().optional().describe('Run remaining steps after a failure (default false)'),
});

export const ReproduceIssueOutput = z.object({
  investigationId: z.string(),
  state: InvestigationStateSchema,
  steps: z.array(StepOutcomeSchema),
  summary: z.object({
    succeeded: z.number(),
    failed: z.number(),
    timedOut: z.number(),
    blocked: z.number(),
    skipped: z.number(),
  }),
  newEvidence: z.object({ fromSeq: z.number(), toSeq: z.number(), countsByType: counts }),
  remainingSeconds: z.number(),
});

// ---- collect_evidence ----

export const CollectEvidenceInput = z.strictObject({
  investigationId: InvestigationId,
  categories: z
    .array(EvidenceTypeSchema)
    .min(1)
    .optional()
    .describe('Evidence types to return (default: all)'),
  sinceSeq: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Only return items with seq greater than this (pagination)'),
  limit: z.number().int().min(1).max(200).optional().describe('Maximum items to return (default 100)'),
  captureScreenshot: z.boolean().optional().describe('Capture a screenshot of the current page first'),
});

export const CollectEvidenceOutput = z.object({
  investigationId: z.string(),
  state: InvestigationStateSchema,
  items: z.array(EvidenceItemSchema),
  timeline: z.array(
    z.object({ id: z.string(), elapsedMs: z.number(), type: EvidenceTypeSchema, summary: z.string() }),
  ),
  returnedCount: z.number(),
  matchingCount: z.number(),
  nextSinceSeq: z.number(),
  countsByType: counts,
  droppedByType: counts,
  screenshot: ScreenshotRefSchema.optional(),
  untrustedContentNotice: z.string(),
});

// ---- analyze_evidence ----

export const AnalyzeEvidenceInput = z.strictObject({
  investigationId: InvestigationId,
  additionalContext: z
    .string()
    .max(4000)
    .optional()
    .describe(
      'Extra context from the client (e.g. recent code changes); used for symptom matching and echoed back',
    ),
});
export const AnalyzeEvidenceOutput = AnalysisSchema;

// ---- generate_bug_report ----

export const GenerateBugReportInput = z.strictObject({ investigationId: InvestigationId });
export const GenerateBugReportOutput = BugReportSchema;

// ---- generate_regression_test ----

export const GenerateRegressionTestInput = z.strictObject({
  investigationId: InvestigationId,
  testName: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[\w\s.,:()'-]+$/, 'Use letters, digits, spaces and basic punctuation only')
    .optional(),
});
export const GenerateRegressionTestOutput = RegressionTestSchema;

// ---- close_investigation ----

export const CloseInvestigationInput = z.strictObject({ investigationId: InvestigationId });
export const CloseInvestigationOutput = z.object({
  investigationId: z.string(),
  state: InvestigationStateSchema,
  retainedUntil: z.string(),
});
