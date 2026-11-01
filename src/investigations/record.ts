import type { BrowserInfo, InvestigationSession, WaitUntil } from '../browser/session.js';
import type { EvidenceStore } from '../evidence/evidenceStore.js';
import type { Action } from '../types/actions.js';
import type { InvestigationState, NavigationOutcome, StepOutcome } from '../types/investigation.js';

export interface WatchConfig {
  loading: string[];
  content: string[];
  heuristics: boolean;
}

export interface ExecutedStep {
  /** The validated action as requested. Kept in memory only (fill values are never written to evidence). */
  action: Action;
  outcome: StepOutcome;
}

export interface InvestigationRecord {
  id: string;
  state: InvestigationState;
  createdAtMs: number;
  deadlineAtMs: number;
  endedAtMs?: number;
  terminalReason?: string;
  /** Redacted target URL (safe to show and persist). */
  targetUrl: string;
  issueDescription: string;
  reportedSteps: string[];
  expectedBehavior?: string;
  viewport: { width: number; height: number };
  watch: WatchConfig;
  waitUntil: WaitUntil;
  store: EvidenceStore;
  session: InvestigationSession | null;
  steps: ExecutedStep[];
  initialNavigation: NavigationOutcome | null;
  browserInfo: BrowserInfo | null;
  artifactsDir: string;
  deadlineTimer?: NodeJS.Timeout;
}
