import { endpointKey, isApiResourceType } from '../evidence/normalize.js';
import type { EvidenceItem, EvidenceOf, EvidenceType } from '../types/evidence.js';
import type { InvestigationState, NavigationOutcome, StepOutcome } from '../types/investigation.js';
import { inferSymptoms } from './symptoms.js';
import type {
  Analysis,
  CandidateCause,
  Confidence,
  EvidenceRef,
  ObservedFact,
  Reproduction,
  SymptomClass,
} from './types.js';
import { UNTRUSTED_NOTICE } from './types.js';

export interface AnalysisInput {
  investigationId: string;
  issueDescription: string;
  additionalContext?: string;
  /** Evidence ordered by time (EvidenceStore.timeline()). */
  timeline: EvidenceItem[];
  steps: StepOutcome[];
  state: InvestigationState;
  droppedByType: Partial<Record<EvidenceType, number>>;
  watch: { loading: string[]; content: string[]; heuristics: boolean };
  initialNavigation: NavigationOutcome | null;
  now?: Date;
}

/** Thresholds are explicit so reports can state them. */
export const THRESHOLDS = {
  /** A blank gap between loader removal and content shorter than this is treated as one render. */
  minGapMs: 50,
  /** Window for a response to count as the trigger of a visibility change. */
  triggerWindowMs: 150,
  slowResponseMs: 1000,
  layoutShiftCls: 0.1,
  proximityMs: 500,
  /** An error this soon after the investigator blocked a request may be a side effect of the block. */
  sideEffectWindowMs: 2000,
};

/** Statuses of the main document that mean the site refused to serve the page. */
const ACCESS_DENIED_STATUSES = new Set([401, 403, 429]);
const NETWORK_ERROR_TEXT = /Failed to fetch|NetworkError|Load failed|ERR_BLOCKED_BY_CLIENT|network error/i;

interface Req {
  requestId: string;
  method: string;
  url: string;
  resourceType: string;
  startMs: number;
  endMs?: number;
  status?: number;
  failed: boolean;
  errorText?: string;
  blocked: boolean;
  evidenceIds: string[];
  endEvidenceId?: string;
  isApi: boolean;
}

interface Transition {
  at: number;
  visible: boolean;
  evidenceId: string;
}

interface Segment {
  index: number;
  startMs: number;
  endMs: number;
  navigationEvidenceId?: string;
  url?: string;
}

const ms = (value: number) => `+${Math.round(value)}ms`;

function collectRequests(timeline: EvidenceItem[]): Req[] {
  const byId = new Map<string, Req>();
  const ordered: Req[] = [];
  for (const item of timeline) {
    if (item.type === 'network_request') {
      const req: Req = {
        requestId: item.details.requestId,
        method: item.details.method,
        url: item.url ?? '',
        resourceType: item.details.resourceType,
        startMs: item.elapsedMs,
        failed: false,
        blocked: false,
        evidenceIds: [item.id],
        isApi: isApiResourceType(item.details.resourceType),
      };
      byId.set(req.requestId, req);
      ordered.push(req);
    } else if (item.type === 'network_response' || item.type === 'network_failure') {
      let req = byId.get(item.details.requestId);
      if (!req) {
        req = {
          requestId: item.details.requestId,
          method: item.details.method,
          url: item.url ?? '',
          resourceType: item.details.resourceType,
          startMs: item.elapsedMs - (item.details.durationMs ?? 0),
          failed: false,
          blocked: false,
          evidenceIds: [],
          isApi: isApiResourceType(item.details.resourceType),
        };
        byId.set(req.requestId, req);
        ordered.push(req);
      }
      req.endMs = item.elapsedMs;
      req.endEvidenceId = item.id;
      req.evidenceIds.push(item.id);
      req.blocked = item.details.blockedByInvestigator;
      if (item.type === 'network_response') {
        req.status = item.details.status;
        req.failed = !item.details.ok;
      } else {
        req.failed = true;
        req.errorText = item.details.errorText;
      }
    }
  }
  return ordered;
}

function segmentsOf(timeline: EvidenceItem[]): Segment[] {
  const navs = timeline.filter(
    (i): i is EvidenceOf<'navigation'> =>
      i.type === 'navigation' && i.details.event === 'main_frame_navigated',
  );
  const end = timeline.length ? timeline[timeline.length - 1]!.elapsedMs + 1 : 1;
  if (navs.length === 0) return [{ index: 0, startMs: 0, endMs: end }];
  return navs.map((nav, i) => ({
    index: i,
    startMs: nav.elapsedMs,
    endMs: navs[i + 1]?.elapsedMs ?? end,
    navigationEvidenceId: nav.id,
    ...(nav.url ? { url: nav.url } : {}),
  }));
}

/** Folds per-selector visibility events into "any element of this role is visible" transitions. */
function aggregateVisibility(events: EvidenceOf<'dom_visibility'>[]): Transition[] {
  const state = new Map<string, boolean>();
  let current = false;
  const out: Transition[] = [];
  for (const e of events) {
    state.set(e.details.selector, e.details.visible);
    const any = [...state.values()].some(Boolean);
    if (any !== current) {
      current = any;
      out.push({ at: e.elapsedMs, visible: any, evidenceId: e.id });
    }
  }
  return out;
}

function visibleAt(transitions: Transition[], at: number): boolean {
  let visible = false;
  for (const t of transitions) {
    if (t.at > at) break;
    visible = t.visible;
  }
  return visible;
}

interface ReentryEpisode {
  segment: Segment;
  showAt: number;
  hideAt?: number;
  showEvidenceId: string;
  hideEvidenceId?: string;
  contentVisibleSince?: number;
  contentEvidenceId?: string;
  contentKnown: boolean;
}

interface GapEpisode {
  segment: Segment;
  hiddenAt: number;
  hideEvidenceId: string;
  contentAt?: number;
  contentEvidenceId?: string;
}

function confidence(level: Confidence['level'], explanation: string): Confidence {
  return { level, explanation };
}

const LEVEL_RANK: Record<Confidence['level'], number> = { low: 0, medium: 1, high: 2 };

export function analyzeEvidence(input: AnalysisInput): Analysis {
  const { timeline } = input;
  const facts: ObservedFact[] = [];
  const causes: Omit<CandidateCause, 'id'>[] = [];
  const limitations: string[] = [
    'Analysis uses deterministic rules over recorded evidence; no LLM was used by the investigator. Candidate causes are hypotheses ranked by evidence, not verified conclusions.',
    'Timestamps are the times at which the investigator observed events (millisecond-level skew between browser, network and page-instrumentation sources is possible).',
    'Visibility and layout-shift observations come from instrumentation running inside the page, which the page could in principle interfere with.',
    'Only Chromium was used; request and response bodies were not captured.',
  ];
  const experiments = new Set<string>();
  const addFact = (category: string, statement: string, evidenceIds: string[]) =>
    facts.push({
      id: `fact_${facts.length + 1}`,
      category,
      statement,
      evidenceIds: evidenceIds.slice(0, 20),
    });

  const requests = collectRequests(timeline);
  const apiRequests = requests.filter((r) => r.isApi);
  const segments = segmentsOf(timeline);
  const ofType = <T extends EvidenceType>(type: T) =>
    timeline.filter((i): i is EvidenceOf<T> => i.type === type);

  // ---- Investigation-level facts -------------------------------------------------
  const nav = input.initialNavigation;
  if (nav) {
    addFact(
      'navigation',
      nav.ok
        ? `Initial navigation to ${nav.finalUrl} completed with HTTP ${nav.status ?? 'n/a'} in ${nav.durationMs}ms.`
        : `Initial navigation to ${nav.finalUrl} did not succeed: ${nav.error ?? `HTTP ${nav.status ?? 'unknown'}`}.`,
      [],
    );
  }
  if (input.steps.length) {
    const byStatus = countBy(input.steps.map((s) => s.status));
    addFact(
      'reproduction-steps',
      `${input.steps.length} reproduction step(s) executed: ${Object.entries(byStatus)
        .map(([k, v]) => `${v} ${k}`)
        .join(', ')}.`,
      input.steps.flatMap((s) => (s.evidenceId ? [s.evidenceId] : [])),
    );
  }
  if (segments.length > 1 || segments[0]?.navigationEvidenceId) {
    addFact(
      'navigation',
      `${segments.length} main-frame document load(s) were observed.`,
      segments.flatMap((s) => (s.navigationEvidenceId ? [s.navigationEvidenceId] : [])),
    );
  }

  // ---- Runtime errors --------------------------------------------------------------
  const pageErrors = ofType('page_error');
  const errorGroups = groupBy(pageErrors, (e) => `${e.details.name}: ${e.details.message}`);
  for (const items of [...errorGroups.values()].slice(0, 5)) {
    addFact(
      'runtime-error',
      `${describeError(items[0]!).full} (${items.length}×, first at ${ms(items[0]!.elapsedMs)}).`,
      ids(items),
    );
  }
  const consoleErrors = ofType('console').filter((c) => c.details.level === 'error');
  const consoleWarnings = ofType('console').filter((c) => c.details.level === 'warning');
  if (consoleErrors.length) {
    addFact('console', `${consoleErrors.length} console error message(s) were logged.`, ids(consoleErrors));
  }
  if (consoleWarnings.length) {
    addFact(
      'console',
      `${consoleWarnings.length} console warning message(s) were logged.`,
      ids(consoleWarnings),
    );
  }
  const injectionSuspects = [...ofType('console'), ...pageErrors].filter(
    (i) => i.details.possiblePromptInjection,
  );
  if (injectionSuspects.length) {
    addFact(
      'security',
      `${injectionSuspects.length} page message(s) contain text resembling instructions to an AI agent; they were recorded as data only.`,
      ids(injectionSuspects),
    );
  }

  // ---- Network -----------------------------------------------------------------------
  const mainDocumentUrls = new Set(segments.flatMap((s) => (s.url ? [s.url] : [])));
  if (nav?.finalUrl) mainDocumentUrls.add(nav.finalUrl);
  // The site refused to serve the page itself (typically a CDN/WAF bot block): no app behaviour was observed.
  const accessDenied = requests.filter(
    (r) =>
      r.resourceType === 'document' &&
      r.status !== undefined &&
      ACCESS_DENIED_STATUSES.has(r.status) &&
      mainDocumentUrls.has(r.url),
  );
  // Cancelled by a navigation or by the page itself; not a failure of the server.
  const aborted = requests.filter(
    (r) => r.failed && r.status === undefined && /ERR_ABORTED/i.test(r.errorText ?? ''),
  );
  const failed = requests.filter(
    (r) => r.failed && !r.blocked && !accessDenied.includes(r) && !aborted.includes(r),
  );
  const blocked = requests.filter((r) => r.blocked);
  const securityEvents = ofType('security');
  const targetSite = siteOf(hostOf(nav?.finalUrl ?? segments[0]?.url ?? ''));
  const isThirdParty = (url: string) => !!targetSite && siteOf(hostOf(url)) !== targetSite;

  if (accessDenied.length) {
    const server = accessDenied
      .map((r) => {
        const end = timeline.find((i) => i.id === r.endEvidenceId);
        return end?.type === 'network_response' ? end.details.headers.server : undefined;
      })
      .find(Boolean);
    addFact(
      'investigation-environment',
      `The site refused to serve the page: ${accessDenied.map((r) => `${r.url} returned HTTP ${r.status}`).join('; ')}${server ? ` (server: ${server})` : ''}.`,
      accessDenied.flatMap((r) => r.evidenceIds),
    );
  }
  if (aborted.length) {
    addFact(
      'network',
      `${aborted.length} request(s) were aborted (net::ERR_ABORTED), usually cancelled by a navigation or by the page itself; they are not treated as failures.`,
      aborted.flatMap((r) => r.evidenceIds).slice(0, 20),
    );
  }
  for (const r of failed.slice(0, 10)) {
    addFact(
      'network',
      `${r.method} ${r.url} ${r.status !== undefined ? `returned HTTP ${r.status}` : `failed (${r.errorText ?? 'network error'})`} at ${ms(r.endMs ?? r.startMs)}.`,
      r.evidenceIds,
    );
  }
  if (securityEvents.length || blocked.length) {
    addFact(
      'investigation-environment',
      `${securityEvents.length} connection(s)/request(s) were blocked by the investigator's own security policy.`,
      [...ids(securityEvents), ...blocked.flatMap((r) => r.evidenceIds)],
    );
  }
  const slow = apiRequests.filter(
    (r) => r.endMs !== undefined && r.endMs - r.startMs >= THRESHOLDS.slowResponseMs,
  );
  for (const r of slow.slice(0, 5)) {
    addFact('network', `${r.method} ${r.url} took ${Math.round(r.endMs! - r.startMs)}ms.`, r.evidenceIds);
  }

  // Duplicate API calls and out-of-order completion, per document.
  const duplicates: { segment: Segment; key: string; reqs: Req[] }[] = [];
  const outOfOrder: { segment: Segment; first: Req; second: Req }[] = [];
  for (const segment of segments) {
    const inSeg = apiRequests.filter((r) => r.startMs >= segment.startMs && r.startMs < segment.endMs);
    for (const [key, reqs] of groupBy(inSeg, (r) => endpointKey(r.method, r.url))) {
      if (reqs.length < 2) continue;
      duplicates.push({ segment, key, reqs });
      for (let i = 0; i < reqs.length - 1; i++) {
        const a = reqs[i]!;
        const b = reqs[i + 1]!;
        if (a.endMs !== undefined && b.endMs !== undefined && b.endMs < a.endMs) {
          outOfOrder.push({ segment, first: a, second: b });
        }
      }
    }
  }
  for (const d of duplicates.slice(0, 5)) {
    addFact(
      'network',
      `${d.key} was requested ${d.reqs.length} times during document load #${d.segment.index + 1} (at ${d.reqs.map((r) => ms(r.startMs)).join(', ')}).`,
      d.reqs.flatMap((r) => r.evidenceIds),
    );
  }

  // ---- Visibility (loading placeholder / content) ------------------------------------
  const visibility = ofType('dom_visibility');
  const explicitLoading = visibility.filter((v) => v.details.role === 'loading' && !v.details.heuristic);
  const heuristicLoading = visibility.filter((v) => v.details.role === 'loading' && v.details.heuristic);
  const loadingEvents = explicitLoading.length ? explicitLoading : heuristicLoading;
  const loadingFromHeuristics = !explicitLoading.length && heuristicLoading.length > 0;
  const contentEvents = visibility.filter((v) => v.details.role === 'content');
  const contentWatched = input.watch.content.length > 0;

  const reentries: ReentryEpisode[] = [];
  const gaps: GapEpisode[] = [];
  const segmentsWithLoader: Segment[] = [];
  for (const segment of segments) {
    const inSeg = (e: EvidenceItem) => e.elapsedMs >= segment.startMs && e.elapsedMs < segment.endMs;
    const L = aggregateVisibility(loadingEvents.filter(inSeg));
    const C = aggregateVisibility(contentEvents.filter(inSeg));
    if (L.length) segmentsWithLoader.push(segment);
    const firstContent = C.find((t) => t.visible);

    let seenHidden = false;
    for (let i = 0; i < L.length; i++) {
      const t = L[i]!;
      if (!t.visible) {
        seenHidden = true;
        // Placeholder removed while no content is visible.
        if (contentWatched && !visibleAt(C, t.at)) {
          const next = C.find((c) => c.visible && c.at >= t.at);
          if (!next || next.at - t.at >= THRESHOLDS.minGapMs) {
            gaps.push({
              segment,
              hiddenAt: t.at,
              hideEvidenceId: t.evidenceId,
              ...(next ? { contentAt: next.at, contentEvidenceId: next.evidenceId } : {}),
            });
          }
        }
        continue;
      }
      // With content watched: any loader appearance after content was first shown.
      // Without: a loader that is shown again after having been hidden.
      const reentered = contentWatched
        ? firstContent !== undefined && t.at > firstContent.at + 5
        : seenHidden;
      if (reentered) {
        const hide = L.slice(i + 1).find((x) => !x.visible);
        reentries.push({
          segment,
          showAt: t.at,
          showEvidenceId: t.evidenceId,
          ...(hide ? { hideAt: hide.at, hideEvidenceId: hide.evidenceId } : {}),
          ...(firstContent
            ? { contentVisibleSince: firstContent.at, contentEvidenceId: firstContent.evidenceId }
            : {}),
          contentKnown: contentWatched,
        });
      }
    }
  }

  for (const r of reentries) {
    addFact(
      'visibility',
      r.contentKnown
        ? `In document load #${r.segment.index + 1}, the loading indicator became visible again at ${ms(r.showAt)} after content had been visible since ${ms(r.contentVisibleSince!)}${r.hideAt !== undefined ? `, and was hidden again at ${ms(r.hideAt)} (${Math.round(r.hideAt - r.showAt)}ms)` : ' and was still visible at the end of the observation'}.`
        : `In document load #${r.segment.index + 1}, the loading indicator was shown, hidden, and shown again at ${ms(r.showAt)}.`,
      [r.contentEvidenceId, r.showEvidenceId, r.hideEvidenceId].filter((x): x is string => !!x),
    );
  }
  for (const g of gaps) {
    addFact(
      'visibility',
      g.contentAt !== undefined
        ? `In document load #${g.segment.index + 1}, the loading indicator was removed at ${ms(g.hiddenAt)} but content only became visible at ${ms(g.contentAt)} (${Math.round(g.contentAt - g.hiddenAt)}ms with neither visible).`
        : `In document load #${g.segment.index + 1}, the loading indicator was removed at ${ms(g.hiddenAt)} and watched content never became visible afterwards.`,
      [g.hideEvidenceId, g.contentEvidenceId].filter((x): x is string => !!x),
    );
  }
  if (loadingFromHeuristics) {
    limitations.push(
      'Loading indicators were identified with built-in CSS heuristics (e.g. class names containing "loading"); provide watch.loading selectors for reliable results.',
    );
  }
  if (!contentWatched) {
    limitations.push(
      'No watch.content selectors were provided, so the investigator cannot tell whether content was visible while a loading indicator was shown.',
    );
  }

  const shifts = ofType('layout_shift');
  const cls = shifts.reduce((max, s) => Math.max(max, s.details.cumulative), 0);
  if (shifts.length) {
    addFact(
      'layout',
      `Layout shifts were recorded (max cumulative score ${cls.toFixed(3)} within a document).`,
      ids(shifts),
    );
  }

  // ---- Candidate causes ----------------------------------------------------------------
  const inferred = inferSymptoms(input.issueDescription, input.additionalContext);
  const relevant = (classes: SymptomClass[]) => classes.some((c) => inferred.includes(c));

  if (reentries.length) {
    const supporting: EvidenceRef[] = [];
    const contradicting: EvidenceRef[] = [];
    let episodesWithCoveringRequest = 0;
    let episodesWithTrigger = 0;
    for (const r of reentries) {
      supporting.push({
        evidenceIds: [r.contentEvidenceId, r.showEvidenceId].filter((x): x is string => !!x),
        note: r.contentKnown
          ? `Loading indicator re-appeared at ${ms(r.showAt)} while content had been visible since ${ms(r.contentVisibleSince!)}.`
          : `Loading indicator re-appeared at ${ms(r.showAt)} after having been hidden.`,
      });
      const covering = apiRequests.filter(
        (q) =>
          Math.abs(q.startMs - r.showAt) <= THRESHOLDS.triggerWindowMs &&
          (r.hideAt === undefined ||
            q.endMs === undefined ||
            Math.abs(q.endMs - r.hideAt) <= THRESHOLDS.triggerWindowMs * 2),
      );
      const triggers = apiRequests.filter(
        (q) =>
          q.endMs !== undefined &&
          q.endMs <= r.showAt + 20 &&
          r.showAt - q.endMs <= THRESHOLDS.triggerWindowMs &&
          !covering.includes(q),
      );
      if (covering.length) {
        episodesWithCoveringRequest++;
        supporting.push({
          evidenceIds: covering.flatMap((q) => q.evidenceIds),
          note: `${covering.map((q) => `${q.method} ${q.url}`).join('; ')} started within ${THRESHOLDS.triggerWindowMs}ms of the indicator re-appearing${r.hideAt !== undefined ? ' and completed shortly before it was hidden' : ''}.`,
        });
      } else {
        contradicting.push({
          evidenceIds: [r.showEvidenceId],
          note: `No API request started within ${THRESHOLDS.triggerWindowMs}ms of the re-appearance at ${ms(r.showAt)}; a network-driven refetch does not explain this episode.`,
        });
      }
      if (triggers.length) {
        episodesWithTrigger++;
        supporting.push({
          evidenceIds: triggers.flatMap((q) => q.evidenceIds),
          note: `${triggers.map((q) => `${q.method} ${q.url}`).join('; ')} completed immediately before the indicator re-appeared (possible trigger).`,
        });
      }
    }
    const dupForEpisodes = duplicates.filter((d) => reentries.some((r) => r.segment === d.segment));
    for (const d of dupForEpisodes) {
      supporting.push({
        evidenceIds: d.reqs.flatMap((r) => r.evidenceIds),
        note: `${d.key} was requested ${d.reqs.length} times in document load #${d.segment.index + 1}, consistent with a refetch after first render.`,
      });
    }
    const cleanLoads = segmentsWithLoader.filter((s) => !reentries.some((r) => r.segment === s));
    if (cleanLoads.length) {
      contradicting.push({
        evidenceIds: cleanLoads.flatMap((s) => (s.navigationEvidenceId ? [s.navigationEvidenceId] : [])),
        note: `${cleanLoads.length} other document load(s) showed a loading indicator without re-appearance, so the behaviour is not fully deterministic under the observed conditions.`,
      });
    }
    if (loadingFromHeuristics) {
      contradicting.push({
        evidenceIds: reentries.map((r) => r.showEvidenceId),
        note: 'The loading indicator was identified heuristically and may not be the element described in the issue.',
      });
    }

    const strong =
      episodesWithCoveringRequest === reentries.length &&
      (episodesWithTrigger > 0 || dupForEpisodes.length > 0);
    const level: Confidence['level'] = strong && !loadingFromHeuristics && contentWatched ? 'medium' : 'low';
    causes.push({
      kind: 'loading_state_reentered',
      title: 'Loading state is re-entered after content has rendered',
      category: 'state-management',
      hypothesis:
        'A data request issued after the first render (for example a refetch triggered by another response) switches the page back into its initial loading state, so the loading placeholder covers content that was already displayed. A shared "loading" flag used for both the initial load and background refreshes is a common cause.',
      symptomClasses: ['loading_flicker'],
      supportingEvidence: supporting,
      contradictingEvidence: contradicting,
      confidence: confidence(
        level,
        level === 'medium'
          ? `The visual re-entry is directly observed in ${reentries.length} document load(s), and every episode coincides with an API request that starts as the indicator appears and completes as it disappears. This is a consistent temporal correlation; it has not been confirmed by changing request timing, so it is not rated high.`
          : `The re-entry is observed, but the link to a specific request is ${episodesWithCoveringRequest ? 'only partly' : 'not'} supported by timing${loadingFromHeuristics ? ' and the indicator was identified heuristically' : ''}${contentWatched ? '' : ', and content visibility was not watched'}.`,
      ),
      suggestedExperiments: [
        'Delay the response that precedes the re-appearance (e.g. in a local mock) and check whether the flicker moves with it; this tests causation rather than correlation.',
        'Inspect the code path handling that response for a state update that resets the page-level loading flag or replaces content with the placeholder.',
        'Reload the page several times (reproduce_issue with multiple reload steps) to measure how often the re-appearance occurs.',
      ],
    });
  }

  if (outOfOrder.length) {
    const supporting = outOfOrder.map((o) => ({
      evidenceIds: [...o.first.evidenceIds, ...o.second.evidenceIds],
      note: `${o.first.method} ${o.first.url} started at ${ms(o.first.startMs)} but finished at ${ms(o.first.endMs!)}, after a later request to the same endpoint that finished at ${ms(o.second.endMs!)}.`,
    }));
    const coincident = outOfOrder.some((o) =>
      visibility.some((v) => Math.abs(v.elapsedMs - o.first.endMs!) <= THRESHOLDS.triggerWindowMs),
    );
    causes.push({
      kind: 'out_of_order_responses',
      title: 'Responses to the same endpoint completed out of order',
      category: 'race-condition',
      hypothesis:
        'An older (stale) response may be applied after a newer one, overwriting fresher UI state. This matters only if the app does not ignore or cancel superseded requests.',
      symptomClasses: ['loading_flicker', 'missing_content'],
      supportingEvidence: supporting,
      contradictingEvidence: coincident
        ? []
        : [{ evidenceIds: [], note: 'No visibility change was observed when the stale response arrived.' }],
      confidence: confidence(
        coincident ? 'medium' : 'low',
        coincident
          ? 'Out-of-order completion is observed and a visible change coincides with the late response; whether the stale data was actually applied is not observable from network evidence alone.'
          : 'Out-of-order completion is observed, but nothing visible changed when the late response arrived.',
      ),
      suggestedExperiments: [
        'Check whether the app aborts (AbortController) or ignores superseded requests.',
        'Reverse the response delays in a mock to see whether the final UI state changes.',
      ],
    });
  }

  if (gaps.length) {
    const supporting: EvidenceRef[] = [];
    const contradicting: EvidenceRef[] = [];
    for (const g of gaps) {
      const end = g.contentAt ?? g.segment.endMs;
      supporting.push({
        evidenceIds: [g.hideEvidenceId, g.contentEvidenceId].filter((x): x is string => !!x),
        note: `Neither the loading indicator nor watched content was visible from ${ms(g.hiddenAt)} to ${g.contentAt !== undefined ? ms(g.contentAt) : 'the end of the observation'}.`,
      });
      const inFlight = apiRequests.filter(
        (q) => q.startMs <= g.hiddenAt && (q.endMs === undefined || q.endMs >= g.hiddenAt),
      );
      if (inFlight.length) {
        supporting.push({
          evidenceIds: inFlight.flatMap((q) => q.evidenceIds),
          note: `${inFlight.map((q) => `${q.method} ${q.url}`).join('; ')} was still in flight when the indicator was removed.`,
        });
      } else {
        contradicting.push({
          evidenceIds: [g.hideEvidenceId],
          note: 'No API request was in flight when the indicator was removed, so the gap is not explained by waiting for data.',
        });
      }
      if (
        g.contentAt !== undefined &&
        apiRequests.some(
          (q) => q.endMs !== undefined && Math.abs(q.endMs - g.contentAt!) <= THRESHOLDS.triggerWindowMs,
        )
      ) {
        supporting.push({
          evidenceIds: [],
          note: `A response completed within ${THRESHOLDS.triggerWindowMs}ms of content appearing at ${ms(end)}.`,
        });
      }
    }
    const level: Confidence['level'] =
      contradicting.length === 0 && !loadingFromHeuristics ? 'medium' : 'low';
    causes.push({
      kind: 'premature_loader_removal',
      title: 'Loading placeholder is removed before content is ready',
      category: 'state-management',
      hypothesis:
        'The loading state is cleared by an event other than the data the content depends on (for example a different request finishing first, or a timer), leaving an empty area until the data arrives.',
      symptomClasses: ['missing_content', 'loading_flicker'],
      supportingEvidence: supporting,
      contradictingEvidence: contradicting,
      confidence: confidence(
        level,
        level === 'medium'
          ? 'The blank interval is directly observed and a data request was in flight throughout it; which code path cleared the loading state is not observable.'
          : 'The blank interval is observed, but the network timing does not clearly explain it or the indicator was identified heuristically.',
      ),
      suggestedExperiments: [
        'Find where the loading flag is cleared and check that it waits for the request that populates the content.',
        'Delay the content request further and check whether the blank interval grows by the same amount.',
      ],
    });
  }

  for (const [message, items] of [...errorGroups.entries()].slice(0, 5)) {
    const first = items[0]!;
    const described = describeError(first);
    const near = apiRequests.filter(
      (q) =>
        q.endMs !== undefined &&
        first.elapsedMs - q.endMs >= 0 &&
        first.elapsedMs - q.endMs <= THRESHOLDS.proximityMs,
    );
    const contentAfter = contentEvents.filter((c) => c.details.visible && c.elapsedMs > first.elapsedMs);
    const supporting: EvidenceRef[] = [
      { evidenceIds: ids(items), note: `Uncaught ${message} was thrown ${items.length} time(s).` },
    ];
    if (near.length) {
      supporting.push({
        evidenceIds: near.flatMap((q) => q.evidenceIds),
        note: `Thrown within ${THRESHOLDS.proximityMs}ms after ${near.map((q) => `${q.method} ${q.url}`).join('; ')} completed (temporal proximity only).`,
      });
    }
    const contradicting: EvidenceRef[] = contentAfter.length
      ? [
          {
            evidenceIds: ids(contentAfter.slice(0, 3)),
            note: 'Watched content became visible after the error, so the error did not prevent rendering.',
          },
        ]
      : [];
    // Our own blocking of requests can surface as page errors ("Failed to fetch").
    const blockedBefore = securityEvents.filter(
      (s) => s.elapsedMs <= first.elapsedMs && first.elapsedMs - s.elapsedMs <= THRESHOLDS.sideEffectWindowMs,
    );
    if (securityEvents.length && NETWORK_ERROR_TEXT.test(message)) {
      contradicting.push({
        evidenceIds: ids(blockedBefore.length ? blockedBefore.slice(0, 5) : securityEvents.slice(0, 5)),
        note: `The error text describes a failed network call, and the investigator blocked ${securityEvents.length} request(s) in this session; the error is likely a side effect of the investigation's security policy, not of the application.`,
      });
    } else if (blockedBefore.length) {
      contradicting.push({
        evidenceIds: ids(blockedBefore.slice(0, 5)),
        note: `The investigator blocked ${blockedBefore.length} request(s) within ${THRESHOLDS.sideEffectWindowMs}ms before this error; it may be a side effect of that blocking.`,
      });
    }
    const isRelevant = relevant(['js_error', 'missing_content']);
    causes.push({
      kind: 'uncaught_exception',
      title: described.title,
      category: 'runtime-error',
      hypothesis: `The uncaught exception "${message}" interrupts the script that handles this part of the page.`,
      symptomClasses: ['js_error', 'missing_content'],
      supportingEvidence: supporting,
      contradictingEvidence: contradicting,
      confidence: confidence(
        isRelevant && !contradicting.length ? 'medium' : 'low',
        `The exception itself is a directly observed fact. Whether it causes the reported issue is ${isRelevant ? 'plausible because the issue describes an error or missing content' : 'unclear because the issue does not describe an error'}${contradicting.length ? ', and there is contradicting evidence' : ''}.`,
      ),
      suggestedExperiments: [
        'Open the stack trace location and check which feature the throwing code belongs to.',
        'Check whether the exception also occurs on a load where the reported symptom does not appear.',
      ],
    });
  }

  for (const [key, reqs] of [...groupBy(failed, (r) => endpointKey(r.method, r.url)).entries()].slice(0, 5)) {
    const laterSuccess = requests.filter(
      (r) => !r.failed && endpointKey(r.method, r.url) === key && r.startMs > reqs[0]!.startMs,
    );
    const consoleAfter = consoleErrors.filter((c) =>
      reqs.some(
        (r) =>
          r.endMs !== undefined && c.elapsedMs >= r.endMs && c.elapsedMs - r.endMs <= THRESHOLDS.proximityMs,
      ),
    );
    const contentAfter = contentEvents.filter(
      (c) => c.details.visible && reqs.some((r) => r.endMs !== undefined && c.elapsedMs > r.endMs),
    );
    const contradicting: EvidenceRef[] = [];
    if (laterSuccess.length) {
      contradicting.push({
        evidenceIds: laterSuccess.flatMap((r) => r.evidenceIds),
        note: 'A later request to the same endpoint succeeded.',
      });
    }
    if (contentAfter.length) {
      contradicting.push({
        evidenceIds: ids(contentAfter.slice(0, 3)),
        note: 'Watched content became visible after the failure, so this request is probably not required for the main content.',
      });
    }
    const overlapsReentry = reentries.some((e) =>
      reqs.some((r) => r.endMs !== undefined && Math.abs(r.endMs - e.showAt) <= THRESHOLDS.triggerWindowMs),
    );
    if (reentries.length && !overlapsReentry) {
      contradicting.push({
        evidenceIds: [],
        note: 'The failure is not temporally aligned with the observed loading-indicator re-appearance.',
      });
    }
    if (reqs.every((r) => r.status === 401)) {
      contradicting.push({
        evidenceIds: [],
        note: 'HTTP 401 means the request was unauthenticated. The investigation runs in a fresh, logged-out session, so this may be expected behaviour.',
      });
    }
    if (isThirdParty(reqs[0]!.url)) {
      contradicting.push({
        evidenceIds: [],
        note: `The request goes to a third-party host (not ${targetSite}); such failures (e.g. tracking or ad services) rarely change the page's own behaviour.`,
      });
    }
    const isRelevant = relevant(['network_failure', 'missing_content']);
    causes.push({
      kind: 'failed_request',
      title: `Request failure: ${key}`,
      category: 'network',
      hypothesis: `The page depends on ${key}, which ${reqs[0]!.status !== undefined ? `returned HTTP ${reqs[0]!.status}` : 'failed at the network level'}; missing data or an unhandled error path may produce the reported behaviour.`,
      symptomClasses: ['network_failure', 'missing_content'],
      supportingEvidence: [
        {
          evidenceIds: reqs.flatMap((r) => r.evidenceIds),
          note: `${reqs.length} failed request(s) to this endpoint.`,
        },
        ...(consoleAfter.length
          ? [
              {
                evidenceIds: ids(consoleAfter),
                note: `Console error(s) logged within ${THRESHOLDS.proximityMs}ms after the failure (temporal proximity only).`,
              },
            ]
          : []),
      ],
      contradictingEvidence: contradicting,
      confidence: confidence(
        isRelevant && contradicting.length === 0 ? 'medium' : 'low',
        `The failed request is directly observed. It is ${isRelevant ? '' : 'not '}related to the symptom classes inferred from the issue description${contradicting.length ? ', and there is contradicting evidence' : ''}.`,
      ),
      suggestedExperiments: [
        `Check the server logs for ${key} at the observed time.`,
        'Verify how the UI handles this endpoint failing (error state vs. silent failure).',
      ],
    });
  }

  if (slow.length) {
    const watchedLoaderDuring = slow.filter((r) =>
      loadingEvents.some(
        (l) =>
          l.details.visible &&
          l.elapsedMs >= r.startMs - THRESHOLDS.triggerWindowMs &&
          l.elapsedMs <= r.endMs!,
      ),
    );
    causes.push({
      kind: 'slow_response',
      title: 'Slow API response(s)',
      category: 'performance',
      hypothesis:
        'Slow responses extend loading states and widen timing windows in which races between requests become visible.',
      symptomClasses: ['slow_loading', 'loading_flicker'],
      supportingEvidence: slow.map((r) => ({
        evidenceIds: r.evidenceIds,
        note: `${r.method} ${r.url} took ${Math.round(r.endMs! - r.startMs)}ms (threshold ${THRESHOLDS.slowResponseMs}ms).`,
      })),
      contradictingEvidence:
        loadingEvents.length && !watchedLoaderDuring.length
          ? [
              {
                evidenceIds: [],
                note: 'No loading indicator was shown while the slow request was in flight.',
              },
            ]
          : [],
      confidence: confidence(
        'low',
        'Response duration is observed; its effect on the UI is inferred, not observed.',
      ),
      suggestedExperiments: [
        'Measure the same endpoint repeatedly to see whether the latency is consistent.',
      ],
    });
  }

  if (cls >= THRESHOLDS.layoutShiftCls) {
    causes.push({
      kind: 'layout_instability',
      title: 'Significant layout shift during load',
      category: 'layout',
      hypothesis:
        'Content is inserted or resized without reserved space, which users perceive as jumping or flicker.',
      symptomClasses: ['loading_flicker'],
      supportingEvidence: [
        {
          evidenceIds: ids(shifts),
          note: `Cumulative layout shift reached ${cls.toFixed(3)} (threshold ${THRESHOLDS.layoutShiftCls}).`,
        },
      ],
      contradictingEvidence: [],
      confidence: confidence(
        'low',
        'Layout shift is measured by the browser, but which element shifted and why is not recorded.',
      ),
      suggestedExperiments: [
        'Reserve space for late-loading elements (min-height, aspect-ratio) and re-measure.',
      ],
    });
  }

  if (securityEvents.length || blocked.length) {
    causes.push({
      kind: 'environment_blocked',
      title: "Requests blocked by the investigator's security policy",
      category: 'investigation-environment',
      hypothesis:
        'Some failures may be artifacts of the investigation environment (egress allowlist, private-address protection, or blocked state-changing requests), not defects in the application.',
      symptomClasses: ['network_failure', 'missing_content'],
      supportingEvidence: [
        {
          evidenceIds: [...ids(securityEvents), ...blocked.flatMap((r) => r.evidenceIds)].slice(0, 20),
          note: 'Blocked by investigator policy.',
        },
      ],
      contradictingEvidence: [],
      confidence: confidence(
        'high',
        'The investigator itself recorded these blocks; whether they matter for the reported issue depends on which requests were blocked.',
      ),
      suggestedExperiments: [
        'If the blocked hosts are legitimate dependencies, add them to INVESTIGATOR_ALLOWED_HOSTS and repeat the investigation.',
      ],
    });
    limitations.push(
      'Some requests were blocked by the investigator, which may change application behaviour compared to production.',
    );
  }

  const servedMainDocuments = requests.filter(
    (r) =>
      r.resourceType === 'document' &&
      mainDocumentUrls.has(r.url) &&
      r.status !== undefined &&
      r.status < 400,
  );
  const allLoadsDenied = accessDenied.length > 0 && servedMainDocuments.length === 0;
  if (accessDenied.length) {
    causes.push({
      kind: 'access_denied',
      title: `The site refused access to the automated browser (HTTP ${[...new Set(accessDenied.map((r) => r.status))].join('/')})`,
      category: 'investigation-environment',
      hypothesis:
        'The site, or its CDN/WAF bot protection, refused to serve the page to the investigator. This describes the investigation environment, not a defect in the application: the application behaviour behind the block was never observed.',
      symptomClasses: ['network_failure', 'missing_content'],
      supportingEvidence: [
        {
          evidenceIds: accessDenied.flatMap((r) => r.evidenceIds),
          note: `Main document responses: ${accessDenied.map((r) => `HTTP ${r.status}`).join(', ')}.`,
        },
      ],
      contradictingEvidence: servedMainDocuments.length
        ? [
            {
              evidenceIds: servedMainDocuments.flatMap((r) => r.evidenceIds),
              note: 'Other loads of the page were served normally, so access is denied only intermittently (e.g. rate limiting).',
            },
          ]
        : [],
      confidence: confidence(
        'high',
        'The refusal is the HTTP status of the page itself. Whether it is bot protection, geo-blocking or rate limiting cannot be distinguished from the status alone.',
      ),
      suggestedExperiments: [
        'Investigate a staging environment, or ask the site owner to allow the investigator (for example a WAF rule for its IP address). The investigator does not attempt to bypass bot protection.',
      ],
    });
    limitations.push(
      allLoadsDenied
        ? 'The site refused to serve the page on every load, so no application behaviour could be observed.'
        : 'The site refused to serve the page on some loads.',
    );
  }

  const failedNavigation = (nav && !nav.ok) || input.steps.some((s) => s.navigation && !s.navigation.ok);
  if (failedNavigation) {
    limitations.push(
      'At least one navigation did not succeed, so later observations may not reflect the intended page.',
    );
  }

  // ---- Reproduction status -------------------------------------------------------------
  // Observed symptoms are what the anomalies directly show, not every class a cause could explain.
  const directlyObserved = new Set<SymptomClass>();
  if (reentries.length || cls >= THRESHOLDS.layoutShiftCls) directlyObserved.add('loading_flicker');
  if (gaps.length) directlyObserved.add('missing_content');
  // Chromium logs "Failed to load resource" for every failed request; that is a network symptom, not a JS error.
  const scriptConsoleErrors = consoleErrors.filter((c) => !/^Failed to load resource/i.test(c.details.text));
  if (pageErrors.length || scriptConsoleErrors.length) directlyObserved.add('js_error');
  if (failed.length) directlyObserved.add('network_failure');
  if (slow.length) directlyObserved.add('slow_loading');

  const reproduction = decideReproduction({
    inferred,
    observed: [...directlyObserved],
    steps: input.steps,
    navigationOk: nav ? nav.ok : false,
    state: input.state,
    loaderObserved: loadingEvents.length > 0,
    dropped: Object.values(input.droppedByType).reduce((a, b) => a + (b ?? 0), 0),
    allLoadsDenied,
  });

  const dropped = Object.entries(input.droppedByType).filter(([, n]) => (n ?? 0) > 0);
  if (dropped.length) {
    limitations.push(
      `Evidence limits were reached; dropped items: ${dropped.map(([t, n]) => `${t}=${n}`).join(', ')}.`,
    );
  }

  // ---- Ranking -------------------------------------------------------------------------
  const ranked = causes
    .map((c, order) => ({ c, order }))
    .sort((a, b) => {
      const ra = relevant(a.c.symptomClasses) ? 1 : 0;
      const rb = relevant(b.c.symptomClasses) ? 1 : 0;
      const ea = a.c.category === 'investigation-environment' ? 0 : 1;
      const eb = b.c.category === 'investigation-environment' ? 0 : 1;
      // Application causes first; environment artifacts are listed last.
      return (
        eb - ea ||
        rb - ra ||
        LEVEL_RANK[b.c.confidence.level] - LEVEL_RANK[a.c.confidence.level] ||
        a.order - b.order
      );
    })
    .map(({ c }, i) => ({ id: `cause_${i + 1}`, ...c }));

  if (!ranked.length) {
    experiments.add(
      'No anomalies were detected. Try additional reproduction steps (reload, interactions) or provide watch selectors for the elements involved.',
    );
  }
  if (!input.watch.loading.length && inferred.includes('loading_flicker')) {
    experiments.add(
      'Provide watch.loading and watch.content CSS selectors in start_investigation so placeholder and content visibility are tracked precisely.',
    );
  }
  if (input.steps.filter((s) => s.action === 'reload' && s.status === 'succeeded').length < 2) {
    experiments.add(
      'Repeat the reproduction (e.g. several reload steps) to estimate how deterministic the behaviour is.',
    );
  }
  for (const c of ranked.slice(0, 3)) c.suggestedExperiments.slice(0, 1).forEach((e) => experiments.add(e));

  return {
    investigationId: input.investigationId,
    generatedAt: (input.now ?? new Date()).toISOString(),
    analysisMethod: 'deterministic-rules',
    llmUsed: false,
    methodNote:
      'No external LLM is configured; this is a deterministic summary produced by explicit rules. Temporal correlation is reported as such and never treated as proof of causation.',
    reproduction,
    observedFacts: facts,
    candidateRootCauses: ranked,
    additionalExperiments: [...experiments],
    limitations,
    ...(input.additionalContext ? { clientContext: input.additionalContext } : {}),
    untrustedContentNotice: UNTRUSTED_NOTICE,
  };
}

function decideReproduction(args: {
  inferred: SymptomClass[];
  observed: SymptomClass[];
  steps: StepOutcome[];
  navigationOk: boolean;
  state: InvestigationState;
  loaderObserved: boolean;
  dropped: number;
  allLoadsDenied: boolean;
}): Reproduction {
  const { inferred, observed } = args;
  const matched = inferred.filter((s) => observed.includes(s));
  const base = { inferredSymptoms: inferred, observedSymptoms: observed, matchedSymptoms: matched };
  const stepProblems = args.steps.filter((s) => s.status !== 'succeeded');

  if (args.allLoadsDenied) {
    return {
      status: 'inconclusive',
      basis:
        'The site refused to serve the page to the investigator on every load (access denied, typically CDN/WAF bot protection), so the application itself was never observed.',
      ...base,
    };
  }

  // A directly observed matching symptom counts even if some steps failed afterwards.
  if (matched.length) {
    return {
      status: 'reproduced',
      basis: `Observed anomalies in the symptom class(es) ${matched.join(', ')}, which the issue description maps to by keyword. This mapping is mechanical; confirm that the observed behaviour is the one described.`,
      ...base,
    };
  }
  if (!args.navigationOk && !args.steps.some((s) => s.status === 'succeeded')) {
    return {
      status: 'inconclusive',
      basis: 'The target page could not be loaded and no reproduction step succeeded.',
      ...base,
    };
  }
  if (!inferred.length) {
    return {
      status: 'inconclusive',
      basis:
        'The issue description could not be mapped to an observable symptom class (flicker/loading, missing content, JS error, network failure, slow loading), so the investigator cannot decide whether the observations match it.',
      ...base,
    };
  }
  if (stepProblems.length) {
    return {
      status: 'inconclusive',
      basis: `No matching symptom was observed, but ${stepProblems.length} step(s) did not succeed (${stepProblems.map((s) => `#${s.index} ${s.status}`).join(', ')}), so the reproduction was incomplete.`,
      ...base,
    };
  }
  if (inferred.includes('loading_flicker') && !args.loaderObserved) {
    return {
      status: 'inconclusive',
      basis:
        'The issue describes a loading/flicker symptom, but no loading indicator was detected; provide watch.loading selectors so it can be observed.',
      ...base,
    };
  }
  if (args.dropped > 0) {
    return {
      status: 'inconclusive',
      basis: 'No matching symptom was observed, but some evidence was dropped due to limits.',
      ...base,
    };
  }
  return {
    status: 'not_reproduced',
    basis: `All executed steps succeeded and no anomaly in the reported symptom class(es) (${inferred.join(', ')}) was observed. This does not prove the bug is absent: timing, data, or environment may differ.`,
    ...base,
  };
}

/** Human-readable error label without Chromium's duplicated "Uncaught" prefixes. */
function describeError(item: EvidenceOf<'page_error'>): { title: string; full: string } {
  const strip = (s: string) => s.replace(/^Uncaught\s+(\(in promise\)\s+)?/i, '');
  const inPromise = /\(in promise\)/i.test(`${item.details.name} ${item.details.message}`);
  const prefix = inPromise ? 'Unhandled promise rejection' : 'Uncaught';
  const name = strip(item.details.name) || 'Error';
  const message = strip(item.details.message);
  const short = message.length > 80 ? `${message.slice(0, 80)}…` : message;
  return { title: `${prefix} ${name}: ${short}`, full: `${prefix} ${name}: ${message}` };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** Approximate registrable domain ("www.ibm.com" -> "ibm.com", "shop.example.co.uk" -> "example.co.uk"). */
function siteOf(host: string): string {
  const parts = host.split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const tld = parts[parts.length - 1]!;
  const sld = parts[parts.length - 2]!;
  return tld.length === 2 && sld.length <= 3 ? parts.slice(-3).join('.') : parts.slice(-2).join('.');
}

function ids(items: { id: string }[]): string[] {
  return items.map((i) => i.id);
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k);
    if (list) list.push(item);
    else map.set(k, [item]);
  }
  return map;
}

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}
