import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { errors, type Browser, type BrowserContext, type Page, type Request, type Route } from 'playwright';
import type { EvidenceStore } from '../evidence/evidenceStore.js';
import {
  isBlockedFailure,
  normalizeConsoleMessage,
  normalizePageError,
  sanitizeErrorText,
  shouldRecordRequest,
  summarizeBrowserError,
} from '../evidence/normalize.js';
import type { EgressPolicy } from '../security/egressPolicy.js';
import { EgressProxy, UPSTREAM_ERROR_HEADER } from '../security/egressProxy.js';
import { pickSafeHeaders, redactText, redactUrl } from '../security/redact.js';
import type { Action } from '../types/actions.js';
import { describeAction } from '../types/actions.js';
import type {
  ScreenshotTrigger,
  StepOutcome,
  NavigationOutcome,
  ScreenshotRef,
} from '../types/investigation.js';
import type { Logger } from '../util/logger.js';
import { resolveLocator } from './locators.js';
import { buildObserverScript, HEURISTIC_LOADING_SELECTORS, ObserverEventSchema } from './pageObserver.js';

export interface SessionParams {
  investigationId: string;
  store: EvidenceStore;
  policy: EgressPolicy;
  artifactsDir: string;
  artifactsRoot: string;
  viewport: { width: number; height: number };
  watch: { loading: string[]; content: string[]; heuristics: boolean };
  allowMutatingRequests: boolean;
  defaultTimeoutMs: number;
  maxScreenshots: number;
  logger: Logger;
}

export interface BrowserInfo {
  name: string;
  version: string;
  userAgent: string;
  viewport: { width: number; height: number };
}

/** The browser-facing operations an investigation needs. Faked in unit tests. */
export interface InvestigationSession {
  readonly browserInfo: BrowserInfo;
  navigate(url: string, options: { waitUntil?: WaitUntil; timeoutMs: number }): Promise<NavigationOutcome>;
  runStep(index: number, action: Action, timeoutMs: number): Promise<StepOutcome>;
  captureScreenshot(trigger: ScreenshotTrigger, label?: string): Promise<ScreenshotRef | null>;
  close(): Promise<void>;
}

export type WaitUntil = 'load' | 'domcontentloaded' | 'networkidle' | 'commit';

export class StepBlockedError extends Error {}

const NOT_IDLE_WARNING =
  'The page loaded but the network never became idle within the timeout (long-lived or unconsumed requests); later steps may run while requests are still in flight.';
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const DESTRUCTIVE_LABEL =
  /\b(delete|remove|destroy|erase|purchase|buy|pay|checkout|place order|confirm order|unsubscribe|deactivate|cancel (subscription|account|order)|transfer|send money|submit payment)\b/i;

/**
 * Owns one isolated BrowserContext, its page, and its egress proxy, and turns
 * browser events into evidence.
 */
export class PlaywrightSession implements InvestigationSession {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private proxy: EgressProxy | null = null;
  private readonly requestIds = new WeakMap<Request, { id: string; start: number }>();
  private requestCounter = 0;
  private screenshotCount = 0;
  private closed = false;
  /** host:port pairs the proxy refused, used to attribute failures to our own policy. */
  private readonly blockedAuthorities = new Set<string>();
  browserInfo: BrowserInfo = {
    name: 'chromium',
    version: 'unknown',
    userAgent: 'unknown',
    viewport: { width: 0, height: 0 },
  };

  private constructor(private readonly params: SessionParams) {}

  static async create(browser: Browser, params: SessionParams): Promise<PlaywrightSession> {
    const session = new PlaywrightSession(params);
    try {
      await session.init(browser);
    } catch (error) {
      await session.close();
      throw error;
    }
    return session;
  }

  private get store(): EvidenceStore {
    return this.params.store;
  }

  private async init(browser: Browser): Promise<void> {
    const { params } = this;
    this.proxy = new EgressProxy({
      policy: params.policy,
      logger: params.logger,
      onBlocked: (event) => {
        this.blockedAuthorities.add(`${event.hostname.toLowerCase()}:${event.port}`);
        this.store.add(
          'security',
          {
            kind: `egress_${event.kind}`,
            hostname: redactText(event.hostname, { maxLength: 255 }),
            port: event.port,
            reason: event.reason,
            message: redactText(event.message, { maxLength: 400 }),
          },
          { source: 'egress-proxy' },
        );
      },
    });
    const proxy = await this.proxy.start();

    const context = await browser.newContext({
      proxy,
      viewport: params.viewport,
      acceptDownloads: false,
      serviceWorkers: 'block',
      ignoreHTTPSErrors: false,
      permissions: [],
      locale: 'en-US',
    });
    this.context = context;
    context.setDefaultTimeout(params.defaultTimeoutMs);
    context.setDefaultNavigationTimeout(params.defaultTimeoutMs);

    await context.route('**/*', (route) => this.handleRoute(route));

    const binding = `__investigator_${crypto.randomBytes(8).toString('hex')}`;
    await context.exposeBinding(binding, (source, payload: unknown) => {
      if (!this.page || source.page !== this.page || source.frame !== this.page.mainFrame()) return;
      this.handleObserverEvent(payload);
    });
    await context.addInitScript({
      content: buildObserverScript({
        binding,
        loading: params.watch.loading,
        content: params.watch.content,
        heuristicLoading: params.watch.heuristics ? HEURISTIC_LOADING_SELECTORS : [],
        maxEvents: 2000,
        pollIntervalMs: 50,
        minLayoutShift: 0.01,
      }),
    });

    context.on('page', (popup) => {
      if (!this.page || popup === this.page) return;
      this.store.add(
        'navigation',
        {
          event: 'popup_closed',
          note: 'A new window/tab was opened by the page and closed by the investigator',
        },
        { source: 'browser-page', url: redactUrl(popup.url()), untrusted: true },
      );
      void popup.close().catch(() => undefined);
    });

    const page = await context.newPage();
    this.page = page;
    this.attachPageListeners(page);

    this.browserInfo = {
      name: browser.browserType().name(),
      version: browser.version(),
      userAgent: redactText(
        await page
          .evaluate('navigator.userAgent')
          .then(String)
          .catch(() => 'unknown'),
        {
          maxLength: 300,
        },
      ),
      viewport: params.viewport,
    };
  }

  private async handleRoute(route: Route): Promise<void> {
    const request = route.request();
    if (!this.params.allowMutatingRequests && MUTATING_METHODS.has(request.method())) {
      let hostname = '';
      let port = 0;
      try {
        const url = new URL(request.url());
        hostname = url.hostname;
        port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
      } catch {
        /* keep defaults */
      }
      this.store.add(
        'security',
        {
          kind: 'mutating_request',
          hostname,
          port,
          reason: 'method_not_allowed',
          message: `${request.method()} request blocked; set INVESTIGATOR_ALLOW_MUTATING_REQUESTS=true to allow state-changing requests`,
        },
        { source: 'investigator', url: redactUrl(request.url()) },
      );
      await route.abort('blockedbyclient').catch(() => undefined);
      return;
    }
    await route.continue().catch(() => undefined);
  }

  private handleObserverEvent(payload: unknown): void {
    const parsed = ObserverEventSchema.safeParse(payload);
    const url = this.page ? redactUrl(this.page.url()) : undefined;
    const opts = { source: 'page-instrumentation' as const, untrusted: true, ...(url ? { url } : {}) };
    if (!parsed.success) {
      this.store.add('instrumentation', { message: 'Discarded malformed observer report' }, opts);
      return;
    }
    const event = parsed.data;
    switch (event.kind) {
      case 'visibility':
        this.store.add(
          'dom_visibility',
          {
            role: event.role,
            selector: event.selector,
            visible: event.visible,
            matchedCount: event.matchedCount,
            visibleCount: event.visibleCount,
            heuristic: event.heuristic,
          },
          opts,
        );
        break;
      case 'layout-shift':
        this.store.add('layout_shift', { value: event.value, cumulative: event.cumulative }, opts);
        break;
      case 'invalid-selector':
        this.store.add(
          'instrumentation',
          {
            message: `Watch selector is not valid CSS and was ignored: ${redactText(event.selector, { maxLength: 300 })}`,
          },
          opts,
        );
        break;
    }
  }

  private attachPageListeners(page: Page): void {
    const store = this.store;

    page.on('console', (msg) => {
      const details = normalizeConsoleMessage({
        type: msg.type(),
        text: msg.text(),
        location: msg.location(),
      });
      if (!details) return;
      const previous = store.last('console');
      if (
        previous &&
        previous.details.text === details.text &&
        previous.details.level === details.level &&
        previous.seq === store.lastSeq
      ) {
        previous.details.repeatCount += 1;
        return;
      }
      store.add('console', details, {
        source: 'browser-console',
        url: redactUrl(page.url()),
        untrusted: true,
      });
    });

    page.on('pageerror', (error) => {
      store.add('page_error', normalizePageError(error), {
        source: 'browser-page',
        url: redactUrl(page.url()),
        untrusted: true,
      });
    });

    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      store.add(
        'navigation',
        { event: 'main_frame_navigated' },
        { source: 'browser-page', url: redactUrl(frame.url()) },
      );
    });
    page.on('domcontentloaded', () =>
      store.add(
        'navigation',
        { event: 'domcontentloaded' },
        { source: 'browser-page', url: redactUrl(page.url()) },
      ),
    );
    page.on('load', () =>
      store.add('navigation', { event: 'load' }, { source: 'browser-page', url: redactUrl(page.url()) }),
    );
    page.on('crash', () =>
      store.add(
        'navigation',
        { event: 'page_crashed' },
        { source: 'browser-page', url: redactUrl(page.url()) },
      ),
    );
    page.on('close', () => {
      if (!this.closed) store.add('navigation', { event: 'page_closed' }, { source: 'browser-page' });
    });
    page.on('dialog', (dialog) => {
      store.add(
        'navigation',
        {
          event: 'dialog_dismissed',
          note: `${dialog.type()} dialog: ${redactText(dialog.message(), { maxLength: 300 })}`,
        },
        { source: 'browser-page', url: redactUrl(page.url()), untrusted: true },
      );
      void dialog.dismiss().catch(() => undefined);
    });
    page.on('download', (download) => {
      store.add(
        'navigation',
        { event: 'download_blocked', note: 'Downloads are disabled for investigations' },
        { source: 'browser-page', url: redactUrl(download.url()) },
      );
      void download.cancel().catch(() => undefined);
    });

    page.on('request', (request) => {
      const id = `req_${++this.requestCounter}`;
      this.requestIds.set(request, { id, start: store.elapsedMs() });
      if (!shouldRecordRequest(request.resourceType(), request.isNavigationRequest())) return;
      store.add(
        'network_request',
        {
          requestId: id,
          method: request.method(),
          resourceType: request.resourceType(),
          isNavigation: request.isNavigationRequest(),
        },
        { source: 'browser-network', url: redactUrl(request.url()) },
      );
    });

    page.on('requestfinished', (request) => {
      void (async () => {
        const meta = this.requestIds.get(request);
        const response = await request.response().catch(() => null);
        if (!response) return;
        const status = response.status();
        const headers = await response.allHeaders().catch(() => ({}) as Record<string, string>);
        const upstreamError = headers[UPSTREAM_ERROR_HEADER];
        if (upstreamError) {
          // A synthetic 502 from our proxy: the server was unreachable, it did not answer 502.
          store.add(
            'network_failure',
            {
              requestId: meta?.id ?? 'unknown',
              method: request.method(),
              resourceType: request.resourceType(),
              errorText: sanitizeErrorText(
                `Connection to server failed (${upstreamError}), reported by the investigator proxy`,
              ),
              ...(meta ? { durationMs: Math.round(store.elapsedMs() - meta.start) } : {}),
              blockedByInvestigator: false,
            },
            { source: 'egress-proxy', url: redactUrl(request.url()) },
          );
          return;
        }
        const record =
          shouldRecordRequest(request.resourceType(), request.isNavigationRequest()) || status >= 400;
        if (!record) return;
        store.add(
          'network_response',
          {
            requestId: meta?.id ?? 'unknown',
            method: request.method(),
            resourceType: request.resourceType(),
            status,
            statusText: redactText(response.statusText(), { maxLength: 100 }),
            ok: status < 400,
            ...(meta ? { durationMs: Math.round(store.elapsedMs() - meta.start) } : {}),
            headers: pickSafeHeaders(response.headers()),
            blockedByInvestigator: status === 403 && this.wasBlockedByProxy(request.url()),
          },
          { source: 'browser-network', url: redactUrl(request.url()) },
        );
      })();
    });

    page.on('requestfailed', (request) => {
      const meta = this.requestIds.get(request);
      const errorText = request.failure()?.errorText ?? 'unknown';
      store.add(
        'network_failure',
        {
          requestId: meta?.id ?? 'unknown',
          method: request.method(),
          resourceType: request.resourceType(),
          errorText: sanitizeErrorText(errorText),
          ...(meta ? { durationMs: Math.round(store.elapsedMs() - meta.start) } : {}),
          blockedByInvestigator: isBlockedFailure(errorText) || this.wasBlockedByProxy(request.url()),
        },
        { source: 'browser-network', url: redactUrl(request.url()) },
      );
    });
  }

  private wasBlockedByProxy(rawUrl: string): boolean {
    try {
      const url = new URL(rawUrl);
      const port = Number(url.port) || (url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80);
      return this.blockedAuthorities.has(`${url.hostname.toLowerCase()}:${port}`);
    } catch {
      return false;
    }
  }

  private requirePage(): Page {
    if (this.closed || !this.page || this.page.isClosed()) throw new Error('Browser page is not available');
    return this.page;
  }

  async navigate(
    url: string,
    options: { waitUntil?: WaitUntil; timeoutMs: number },
  ): Promise<NavigationOutcome> {
    const started = this.store.elapsedMs();
    const decision = await this.params.policy.checkUrl(url);
    if (!decision.allowed) {
      return {
        ok: false,
        blockedByPolicy: true,
        error: decision.message,
        durationMs: 0,
        finalUrl: redactUrl(url),
      };
    }
    const page = this.requirePage();
    try {
      const waitUntil = options.waitUntil ?? 'load';
      const response = await page.goto(url, {
        waitUntil: waitUntil === 'networkidle' ? 'load' : waitUntil,
        timeout: options.timeoutMs,
      });
      const networkIdleReached = await this.settle(page, waitUntil, started, options.timeoutMs);
      const finalUrl = page.url();
      const upstreamError = response ? (await response.allHeaders())[UPSTREAM_ERROR_HEADER] : undefined;
      if (upstreamError) {
        return {
          ok: false,
          blockedByPolicy: false,
          error: `Could not connect to the server (${sanitizeErrorText(upstreamError)})`,
          durationMs: Math.round(this.store.elapsedMs() - started),
          finalUrl: redactUrl(finalUrl),
        };
      }
      const status = response?.status();
      const blocked = status === 403 && this.wasBlockedByProxy(finalUrl);
      return {
        ok: !!response && response.ok() && !finalUrl.startsWith('chrome-error:'),
        ...(status !== undefined ? { status } : {}),
        ...(networkIdleReached !== undefined ? { networkIdleReached } : {}),
        blockedByPolicy: blocked,
        ...(blocked
          ? { error: 'The final destination was blocked by the egress policy (possibly after a redirect)' }
          : {}),
        durationMs: Math.round(this.store.elapsedMs() - started),
        finalUrl: redactUrl(finalUrl),
      };
    } catch (error) {
      return {
        ok: false,
        blockedByPolicy: this.wasBlockedByProxy(url),
        error: summarizeBrowserError(error instanceof Error ? error.message : String(error)),
        timedOut: error instanceof errors.TimeoutError,
        durationMs: Math.round(this.store.elapsedMs() - started),
        finalUrl: redactUrl(this.page?.url() ?? url),
      };
    }
  }

  /**
   * 'networkidle' is treated as an optional settle phase after 'load': pages
   * with long-lived or unconsumed requests never become idle, and that must not
   * turn a successful navigation into a failure. Returns undefined when no
   * settle was requested.
   */
  private async settle(
    page: Page,
    waitUntil: WaitUntil,
    startedMs: number,
    timeoutMs: number,
  ): Promise<boolean | undefined> {
    if (waitUntil !== 'networkidle') return undefined;
    const remaining = Math.max(100, timeoutMs - (this.store.elapsedMs() - startedMs));
    try {
      await page.waitForLoadState('networkidle', { timeout: remaining });
      return true;
    } catch {
      return false;
    }
  }

  async runStep(index: number, action: Action, timeoutMs: number): Promise<StepOutcome> {
    const started = this.store.elapsedMs();
    const description = redactText(describeAction(action), { maxLength: 300 });
    let status: StepOutcome['status'] = 'succeeded';
    let error: string | undefined;
    let screenshot: ScreenshotRef | null = null;
    let navigation: NavigationOutcome | undefined;
    let warning: string | undefined;

    try {
      const page = this.requirePage();
      switch (action.action) {
        case 'navigate': {
          navigation = await this.navigate(action.url, { waitUntil: action.waitUntil ?? 'load', timeoutMs });
          if (navigation.blockedByPolicy)
            throw new StepBlockedError(navigation.error ?? 'Blocked by egress policy');
          if (navigation.timedOut) throw new errors.TimeoutError(navigation.error ?? 'Navigation timed out');
          if (!navigation.ok)
            throw new Error(navigation.error ?? `Navigation returned HTTP ${navigation.status ?? 'error'}`);
          if (navigation.networkIdleReached === false) warning = NOT_IDLE_WARNING;
          break;
        }
        case 'reload': {
          const waitUntil = action.waitUntil ?? 'load';
          const response = await page.reload({
            waitUntil: waitUntil === 'networkidle' ? 'load' : waitUntil,
            timeout: timeoutMs,
          });
          if (response && !response.ok()) throw new Error(`Reload returned HTTP ${response.status()}`);
          if ((await this.settle(page, waitUntil, started, timeoutMs)) === false) warning = NOT_IDLE_WARNING;
          break;
        }
        case 'click': {
          const locator = resolveLocator(page, action.target);
          if (!this.params.allowMutatingRequests) {
            const label = [
              await locator.innerText({ timeout: timeoutMs }).catch(() => ''),
              await locator.getAttribute('aria-label', { timeout: timeoutMs }).catch(() => ''),
              await locator.getAttribute('value', { timeout: timeoutMs }).catch(() => ''),
            ].join(' ');
            if (DESTRUCTIVE_LABEL.test(label)) {
              throw new StepBlockedError(
                'Refusing to click an element that looks destructive (delete/purchase/pay/...). Mutating actions are disabled by server policy.',
              );
            }
          }
          await locator.click({ timeout: timeoutMs });
          break;
        }
        case 'fill':
          await resolveLocator(page, action.target).fill(action.value, { timeout: timeoutMs });
          break;
        case 'select':
          await resolveLocator(page, action.target).selectOption(action.option, { timeout: timeoutMs });
          break;
        case 'waitFor':
          await resolveLocator(page, action.target).waitFor({
            state: action.state ?? 'visible',
            timeout: timeoutMs,
          });
          break;
        case 'screenshot':
          screenshot = await this.captureScreenshot('action', action.label);
          if (!screenshot) throw new Error('Screenshot budget exhausted or page unavailable');
          break;
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      if (caught instanceof StepBlockedError) status = 'blocked';
      else if (caught instanceof errors.TimeoutError) status = 'timed_out';
      else status = 'failed';
      error = summarizeBrowserError(message);
      if (this.closed) error = `Browser session closed during the step (${error})`;
    }

    const durationMs = Math.round(this.store.elapsedMs() - started);
    const evidence = this.store.add(
      'action',
      {
        stepIndex: index,
        action: action.action,
        description,
        status,
        durationMs,
        ...(error ? { error } : {}),
      },
      { source: 'investigator', ...(this.page && !this.closed ? { url: redactUrl(this.page.url()) } : {}) },
    );
    if (status !== 'succeeded' && !this.closed) {
      screenshot = (await this.captureScreenshot('step_failure', `step ${index} ${status}`)) ?? screenshot;
    }
    return {
      index,
      action: action.action,
      description,
      status,
      durationMs,
      ...(error ? { error } : {}),
      ...(warning ? { warning } : {}),
      ...(screenshot ? { screenshot } : {}),
      ...(navigation ? { navigation } : {}),
      finalUrl: this.page && !this.closed ? redactUrl(this.page.url()) : '',
      ...(evidence ? { evidenceId: evidence.id } : {}),
    };
  }

  async captureScreenshot(trigger: ScreenshotTrigger, label?: string): Promise<ScreenshotRef | null> {
    if (this.closed || !this.page || this.page.isClosed()) return null;
    if (this.screenshotCount >= this.params.maxScreenshots) return null;
    this.screenshotCount += 1;
    const file = `screenshot-${String(this.screenshotCount).padStart(3, '0')}.png`;
    const absolutePath = path.join(this.params.artifactsDir, file);
    try {
      await fs.mkdir(this.params.artifactsDir, { recursive: true, mode: 0o700 });
      await this.page.screenshot({ path: absolutePath, type: 'png', timeout: 10_000 });
    } catch (error) {
      this.params.logger.warn('screenshot failed', { error: String(error) });
      return null;
    }
    const relative = path.relative(this.params.artifactsRoot, absolutePath).split(path.sep).join('/');
    const safeLabel = label ? redactText(label, { maxLength: 80 }) : undefined;
    const item = this.store.add(
      'screenshot',
      { ...(safeLabel ? { label: safeLabel } : {}), file: relative, absolutePath, trigger },
      { source: 'investigator', url: redactUrl(this.page.url()) },
    );
    return {
      evidenceId: item?.id ?? '',
      file: relative,
      absolutePath,
      ...(safeLabel ? { label: safeLabel } : {}),
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const context = this.context;
    this.context = null;
    this.page = null;
    if (context) await context.close().catch(() => undefined);
    if (this.proxy) await this.proxy.close().catch(() => undefined);
    this.proxy = null;
  }
}
