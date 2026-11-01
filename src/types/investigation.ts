import { z } from 'zod';

export const InvestigationStateSchema = z.enum([
  'starting',
  'ready',
  'running',
  'closed',
  'failed',
  'expired',
]);
export type InvestigationState = z.infer<typeof InvestigationStateSchema>;

export const TERMINAL_STATES: ReadonlySet<InvestigationState> = new Set(['closed', 'failed', 'expired']);

/**
 * Allowed state transitions.
 *
 *   starting ──► ready ◄──► running
 *      │           │           │
 *      └───────────┴───────────┴──► closed | failed | expired   (terminal)
 *
 * Terminal states release the browser context; evidence is kept until the
 * retention period ends.
 */
const TRANSITIONS: Record<InvestigationState, readonly InvestigationState[]> = {
  starting: ['ready', 'closed', 'failed', 'expired'],
  ready: ['running', 'closed', 'failed', 'expired'],
  running: ['ready', 'closed', 'failed', 'expired'],
  closed: [],
  failed: [],
  expired: [],
};

export function canTransition(from: InvestigationState, to: InvestigationState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(state: InvestigationState): boolean {
  return TERMINAL_STATES.has(state);
}

export const ScreenshotRefSchema = z.object({
  evidenceId: z.string(),
  file: z.string().describe('Path relative to the artifacts directory'),
  absolutePath: z.string(),
  label: z.string().optional(),
});
export type ScreenshotRef = z.infer<typeof ScreenshotRefSchema>;
export type ScreenshotTrigger = 'action' | 'navigation' | 'step_failure' | 'collect';

export const NavigationOutcomeSchema = z.object({
  ok: z.boolean(),
  status: z.number().int().optional(),
  finalUrl: z.string(),
  durationMs: z.number(),
  blockedByPolicy: z.boolean(),
  timedOut: z.boolean().optional(),
  networkIdleReached: z
    .boolean()
    .optional()
    .describe(
      "Only set when waitUntil was 'networkidle': whether the network became idle before the timeout",
    ),
  error: z.string().optional(),
});
export type NavigationOutcome = z.infer<typeof NavigationOutcomeSchema>;

export const StepStatusSchema = z.enum(['succeeded', 'failed', 'timed_out', 'blocked', 'skipped']);

export const StepOutcomeSchema = z.object({
  index: z.number().int(),
  action: z.string(),
  description: z.string(),
  status: StepStatusSchema,
  durationMs: z.number(),
  error: z.string().optional(),
  warning: z.string().optional(),
  finalUrl: z.string(),
  screenshot: ScreenshotRefSchema.optional(),
  navigation: NavigationOutcomeSchema.optional(),
  evidenceId: z.string().optional(),
});
export type StepOutcome = z.infer<typeof StepOutcomeSchema>;
