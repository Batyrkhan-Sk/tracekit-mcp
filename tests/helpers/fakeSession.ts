import type { InvestigationSession, SessionParams, WaitUntil } from '../../src/browser/session.js';
import type { SessionFactory } from '../../src/investigations/manager.js';
import { describeAction, type Action } from '../../src/types/actions.js';
import type { NavigationOutcome, ScreenshotRef, StepOutcome } from '../../src/types/investigation.js';

export interface FakeBehaviour {
  /** Make the session factory throw. */
  failCreate?: boolean;
  /** Navigation result for URLs containing this substring is a failure. */
  failNavigationFor?: string;
  /** Per-step artificial delay in ms. */
  stepDelayMs?: number;
}

/** A browser-free session that records evidence like the real one, for lifecycle and protocol tests. */
export class FakeSession implements InvestigationSession {
  closed = false;
  readonly browserInfo;
  readonly navigations: string[] = [];

  constructor(
    readonly params: SessionParams,
    private readonly behaviour: FakeBehaviour,
  ) {
    this.browserInfo = { name: 'fake', version: '0.0', userAgent: 'fake-agent', viewport: params.viewport };
  }

  async navigate(
    url: string,
    _options: { waitUntil?: WaitUntil; timeoutMs: number },
  ): Promise<NavigationOutcome> {
    this.navigations.push(url);
    const fail = this.behaviour.failNavigationFor && url.includes(this.behaviour.failNavigationFor);
    this.params.store.add('navigation', { event: 'main_frame_navigated' }, { source: 'browser-page', url });
    return fail
      ? {
          ok: false,
          blockedByPolicy: false,
          durationMs: 1,
          finalUrl: url,
          error: 'net::ERR_CONNECTION_REFUSED',
        }
      : { ok: true, status: 200, blockedByPolicy: false, durationMs: 1, finalUrl: url };
  }

  async runStep(index: number, action: Action, timeoutMs: number): Promise<StepOutcome> {
    if (this.behaviour.stepDelayMs) await new Promise((r) => setTimeout(r, this.behaviour.stepDelayMs));
    if (this.closed) {
      return {
        index,
        action: action.action,
        description: describeAction(action),
        status: 'failed',
        durationMs: 0,
        error: 'closed',
        finalUrl: '',
      };
    }
    const timedOut =
      action.action === 'waitFor' && action.target.by === 'testId' && action.target.testId === 'missing';
    const status = timedOut ? 'timed_out' : 'succeeded';
    const item = this.params.store.add(
      'action',
      {
        stepIndex: index,
        action: action.action,
        description: describeAction(action),
        status,
        durationMs: 1,
        ...(timedOut ? { error: `Timeout ${timeoutMs}ms exceeded` } : {}),
      },
      { source: 'investigator' },
    );
    return {
      index,
      action: action.action,
      description: describeAction(action),
      status,
      durationMs: 1,
      ...(timedOut ? { error: `Timeout ${timeoutMs}ms exceeded` } : {}),
      finalUrl: 'http://example.test/',
      ...(item ? { evidenceId: item.id } : {}),
    };
  }

  async captureScreenshot(): Promise<ScreenshotRef | null> {
    return null;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export function fakeSessionFactory(behaviour: FakeBehaviour = {}): {
  factory: SessionFactory;
  sessions: FakeSession[];
} {
  const sessions: FakeSession[] = [];
  const factory: SessionFactory = async (params) => {
    if (behaviour.failCreate) throw new Error('browser launch failed');
    const session = new FakeSession(params, behaviour);
    sessions.push(session);
    return session;
  };
  return { factory, sessions };
}

/** Resolver that maps every hostname to a public address, so tests never depend on real DNS. */
export const publicResolver = async () => [{ address: '93.184.216.34', family: 4 as const }];
