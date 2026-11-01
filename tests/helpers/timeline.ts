import { EvidenceStore, type Clock } from '../../src/evidence/evidenceStore.js';

/**
 * Builds deterministic evidence timelines for analyzer and report tests.
 * `at(ms)` moves the clock; helpers add the same evidence the browser layer would.
 */
export class TimelineBuilder {
  private mono = 0;
  private reqCounter = 0;
  readonly clock: Clock = { now: () => 1_700_000_000_000 + this.mono, monotonic: () => this.mono };
  readonly store: EvidenceStore;

  constructor(id = 'inv_00000000-0000-4000-8000-000000000000') {
    this.store = new EvidenceStore(id, this.clock);
  }

  at(ms: number): this {
    this.mono = ms;
    return this;
  }

  navigate(url = 'http://app.test/catalog'): this {
    this.store.add('navigation', { event: 'main_frame_navigated' }, { source: 'browser-page', url });
    return this;
  }

  visibility(role: 'loading' | 'content', selector: string, visible: boolean, heuristic = false): this {
    this.store.add(
      'dom_visibility',
      { role, selector, visible, matchedCount: 1, visibleCount: visible ? 1 : 0, heuristic },
      { source: 'page-instrumentation', untrusted: true },
    );
    return this;
  }

  /** Records a request at the current time; returns its id for `respond`. */
  request(url: string, method = 'GET', resourceType = 'fetch'): string {
    const requestId = `req_${++this.reqCounter}`;
    this.store.add(
      'network_request',
      { requestId, method, resourceType, isNavigation: false },
      { source: 'browser-network', url },
    );
    this.starts.set(requestId, { url, method, resourceType, start: this.mono });
    return requestId;
  }

  private readonly starts = new Map<
    string,
    { url: string; method: string; resourceType: string; start: number }
  >();

  respond(requestId: string, status = 200, blocked = false): this {
    const s = this.starts.get(requestId)!;
    this.store.add(
      'network_response',
      {
        requestId,
        method: s.method,
        resourceType: s.resourceType,
        status,
        statusText: '',
        ok: status < 400,
        durationMs: this.mono - s.start,
        headers: {},
        blockedByInvestigator: blocked,
      },
      { source: 'browser-network', url: s.url },
    );
    return this;
  }

  fail(requestId: string, errorText = 'net::ERR_CONNECTION_REFUSED', blocked = false): this {
    const s = this.starts.get(requestId)!;
    this.store.add(
      'network_failure',
      {
        requestId,
        method: s.method,
        resourceType: s.resourceType,
        errorText,
        durationMs: this.mono - s.start,
        blockedByInvestigator: blocked,
      },
      { source: 'browser-network', url: s.url },
    );
    return this;
  }

  pageError(message: string, name = 'TypeError'): this {
    this.store.add(
      'page_error',
      { name, message, possiblePromptInjection: false },
      { source: 'browser-page', untrusted: true },
    );
    return this;
  }

  consoleError(text: string): this {
    this.store.add(
      'console',
      { level: 'error', text, repeatCount: 1, possiblePromptInjection: false },
      { source: 'browser-console', untrusted: true },
    );
    return this;
  }

  security(hostname: string): this {
    this.store.add(
      'security',
      { kind: 'egress_http', hostname, port: 80, reason: 'blocked_address', message: 'blocked' },
      { source: 'egress-proxy' },
    );
    return this;
  }
}

export const LOADER = '[data-testid="catalog-loading"]';
export const CONTENT = '[data-testid="catalog-grid"]';

/** The demo bug: content renders, then a follow-up request re-enables the page-level loader. */
export function flickerTimeline(): TimelineBuilder {
  const t = new TimelineBuilder();
  t.at(0).navigate();
  t.at(10).visibility('loading', LOADER, true);
  const products = t.at(20).request('http://app.test/api/products');
  const prefs = t.request('http://app.test/api/preferences');
  t.at(180).respond(products);
  t.at(182).visibility('loading', LOADER, false).visibility('content', CONTENT, true);
  t.at(620).respond(prefs);
  const resort = t.at(621).request('http://app.test/api/products?sort=price');
  t.at(622).visibility('loading', LOADER, true);
  t.at(930).respond(resort);
  t.at(932).visibility('loading', LOADER, false);
  return t;
}
