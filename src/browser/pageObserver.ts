import { z } from 'zod';

/**
 * A fixed observer script injected into every page of an investigation.
 *
 * It reports visibility changes of "loading" and "content" elements and
 * layout shifts, which is what is needed to observe flicker and placeholder
 * bugs that never show up in console or network logs.
 *
 * Security notes:
 * - The script is a constant. Client-provided CSS selectors are passed as JSON
 *   data, never concatenated into code, so clients cannot execute arbitrary JS.
 * - The script runs inside the untrusted page. The page can tamper with it or
 *   call the reporting binding itself, so its reports are labelled
 *   `page-instrumentation` / untrusted and validated on receipt.
 * - It is written as a plain string (not a serialized TS function) so build
 *   tooling cannot inject helper references that do not exist in the page.
 */
const OBSERVER_SOURCE = String.raw`
(function (cfg) {
  if (window.top !== window) return;
  var MO = window.MutationObserver;
  var PO = window.PerformanceObserver;
  var getStyle = window.getComputedStyle.bind(window);
  var qsa = Document.prototype.querySelectorAll;
  var perfNow = performance.now.bind(performance);
  var budget = cfg.maxEvents;
  var queue = [];

  function flush() {
    var fn = window[cfg.binding];
    if (typeof fn !== 'function') return;
    while (queue.length) {
      try { fn(queue.shift()); } catch (e) { /* ignore */ }
    }
  }
  function send(evt) {
    if (budget <= 0) return;
    budget--;
    evt.t = perfNow();
    queue.push(evt);
    flush();
  }

  var groups = [];
  cfg.loading.forEach(function (s) { groups.push({ role: 'loading', selector: s, heuristic: false }); });
  cfg.content.forEach(function (s) { groups.push({ role: 'content', selector: s, heuristic: false }); });
  cfg.heuristicLoading.forEach(function (s) { groups.push({ role: 'loading', selector: s, heuristic: true }); });

  function isVisible(el) {
    if (!el.getClientRects().length) return false;
    var st = getStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) === 0) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function check() {
    if (!document.documentElement) return;
    for (var i = 0; i < groups.length; i++) {
      var g = groups[i];
      if (g.invalid) continue;
      var els;
      try { els = qsa.call(document, g.selector); }
      catch (e) { g.invalid = true; send({ kind: 'invalid-selector', selector: g.selector }); continue; }
      var visibleCount = 0;
      for (var j = 0; j < els.length; j++) if (isVisible(els[j])) visibleCount++;
      var visible = visibleCount > 0;
      if (g.last === undefined ? visible : g.last !== visible) {
        g.last = visible;
        send({ kind: 'visibility', role: g.role, selector: g.selector, heuristic: g.heuristic,
               visible: visible, matchedCount: els.length, visibleCount: visibleCount });
      }
    }
  }

  var scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    Promise.resolve().then(function () { scheduled = false; check(); });
  }

  try {
    new MO(schedule).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  } catch (e) { /* ignore */ }
  // Style changes driven by stylesheets/animations do not always mutate the DOM.
  setInterval(check, cfg.pollIntervalMs);
  document.addEventListener('DOMContentLoaded', check);
  window.addEventListener('load', check);

  if (PO) {
    try {
      var cumulative = 0;
      new PO(function (list) {
        list.getEntries().forEach(function (entry) {
          if (entry.hadRecentInput) return;
          cumulative += entry.value;
          if (entry.value >= cfg.minLayoutShift) send({ kind: 'layout-shift', value: entry.value, cumulative: cumulative });
        });
      }).observe({ type: 'layout-shift', buffered: true });
    } catch (e) { /* ignore */ }
  }
  setInterval(flush, 250);
})`;

export interface ObserverConfig {
  binding: string;
  loading: string[];
  content: string[];
  heuristicLoading: string[];
  maxEvents: number;
  pollIntervalMs: number;
  minLayoutShift: number;
}

/** Built-in guesses for loading indicators, used in addition to client-provided selectors. */
export const HEURISTIC_LOADING_SELECTORS = [
  '[aria-busy="true"]',
  '[role="progressbar"]',
  '[class*="skeleton" i]',
  '[class*="spinner" i]',
  '[class*="loading" i]',
  '[class*="placeholder" i]',
];

export function buildObserverScript(config: ObserverConfig): string {
  // JSON is a valid JS expression; selectors stay inert string data.
  return `${OBSERVER_SOURCE}(${JSON.stringify(config)});`;
}

/** Schema used to validate reports received from the (untrusted) page. */
export const ObserverEventSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('visibility'),
    role: z.enum(['loading', 'content']),
    selector: z.string().max(500),
    heuristic: z.boolean(),
    visible: z.boolean(),
    matchedCount: z.number().int().min(0).max(1_000_000),
    visibleCount: z.number().int().min(0).max(1_000_000),
    t: z.number(),
  }),
  z.object({
    kind: z.literal('layout-shift'),
    value: z.number().min(0).max(100),
    cumulative: z.number().min(0).max(10_000),
    t: z.number(),
  }),
  z.object({ kind: z.literal('invalid-selector'), selector: z.string().max(500), t: z.number() }),
]);
export type ObserverEvent = z.infer<typeof ObserverEventSchema>;
