import { describe, expect, it } from 'vitest';
import { analyzeEvidence, type AnalysisInput } from '../../src/diagnosis/analyzer.js';
import { inferSymptoms } from '../../src/diagnosis/symptoms.js';
import { AnalysisSchema } from '../../src/diagnosis/types.js';
import type { StepOutcome } from '../../src/types/investigation.js';
import { CONTENT, flickerTimeline, LOADER, TimelineBuilder } from '../helpers/timeline.js';

const FLICKER_ISSUE =
  'After refreshing the catalog page, a loading placeholder briefly covers the content, and the page flickers before stabilizing.';

function input(t: TimelineBuilder, overrides: Partial<AnalysisInput> = {}): AnalysisInput {
  return {
    investigationId: t.store.investigationId,
    issueDescription: FLICKER_ISSUE,
    timeline: t.store.timeline(),
    steps: [],
    state: 'ready',
    droppedByType: t.store.dropped(),
    watch: { loading: [LOADER], content: [CONTENT], heuristics: true },
    initialNavigation: {
      ok: true,
      status: 200,
      finalUrl: 'http://app.test/catalog',
      durationMs: 50,
      blockedByPolicy: false,
    },
    now: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

const step = (index: number, status: StepOutcome['status'], action = 'reload'): StepOutcome => ({
  index,
  action,
  description: action,
  status,
  durationMs: 10,
  finalUrl: 'http://app.test/catalog',
});

describe('inferSymptoms', () => {
  it('maps descriptions to symptom classes', () => {
    expect(inferSymptoms(FLICKER_ISSUE)).toEqual(['loading_flicker']);
    expect(inferSymptoms('The page is blank and the console shows a TypeError')).toEqual([
      'missing_content',
      'js_error',
    ]);
    expect(inferSymptoms('The products API request fails with 500')).toContain('network_failure');
    expect(inferSymptoms('The colors look wrong')).toEqual([]);
  });
});

describe('analyzeEvidence', () => {
  it('detects the loading-state re-entry, explains confidence and stays below "high"', () => {
    const analysis = analyzeEvidence(input(flickerTimeline()));
    expect(() => AnalysisSchema.parse(analysis)).not.toThrow();
    expect(analysis.llmUsed).toBe(false);
    expect(analysis.reproduction.status).toBe('reproduced');
    expect(analysis.reproduction.matchedSymptoms).toEqual(['loading_flicker']);

    const top = analysis.candidateRootCauses[0]!;
    expect(top.kind).toBe('loading_state_reentered');
    expect(top.confidence.level).toBe('medium');
    expect(top.confidence.explanation).toMatch(/correlation/i);
    const notes = top.supportingEvidence.map((s) => s.note).join('\n');
    expect(notes).toContain('/api/products?sort=price');
    expect(notes).toContain('/api/preferences');
    expect(analysis.observedFacts.some((f) => f.statement.includes('became visible again at +622ms'))).toBe(
      true,
    );
  });

  it('every referenced evidence id exists', () => {
    const t = flickerTimeline();
    const analysis = analyzeEvidence(input(t));
    const ids = [
      ...analysis.observedFacts.flatMap((f) => f.evidenceIds),
      ...analysis.candidateRootCauses.flatMap((c) =>
        [...c.supportingEvidence, ...c.contradictingEvidence].flatMap((e) => e.evidenceIds),
      ),
    ];
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(t.store.get(id), id).toBeDefined();
  });

  it('reports no causes and "not_reproduced" for a clean load', () => {
    const t = new TimelineBuilder();
    t.at(0).navigate();
    t.at(5).visibility('loading', LOADER, true);
    const r = t.at(10).request('http://app.test/api/products');
    t.at(100).respond(r);
    t.at(101).visibility('loading', LOADER, false).visibility('content', CONTENT, true);
    const analysis = analyzeEvidence(input(t, { steps: [step(1, 'succeeded')] }));
    expect(analysis.candidateRootCauses).toEqual([]);
    expect(analysis.reproduction.status).toBe('not_reproduced');
    expect(analysis.reproduction.basis).toMatch(/does not prove/);
    expect(analysis.observedFacts.some((f) => f.category === 'visibility')).toBe(false);
    expect(
      analysis.observedFacts.some((f) => f.category === 'runtime-error' || f.category === 'console'),
    ).toBe(false);
  });

  it('marks re-entry as low confidence when no request explains it', () => {
    const t = new TimelineBuilder();
    t.at(0).navigate();
    t.at(5).visibility('loading', LOADER, true);
    t.at(100).visibility('loading', LOADER, false).visibility('content', CONTENT, true);
    t.at(400).visibility('loading', LOADER, true);
    t.at(500).visibility('loading', LOADER, false);
    const cause = analyzeEvidence(input(t)).candidateRootCauses[0]!;
    expect(cause.kind).toBe('loading_state_reentered');
    expect(cause.confidence.level).toBe('low');
    expect(cause.contradictingEvidence[0]!.note).toMatch(/No API request/);
  });

  it('notes non-determinism across loads as contradicting evidence', () => {
    const t = flickerTimeline();
    t.at(2000).navigate();
    t.at(2010).visibility('loading', LOADER, true);
    t.at(2100).visibility('loading', LOADER, false).visibility('content', CONTENT, true);
    const cause = analyzeEvidence(input(t)).candidateRootCauses[0]!;
    expect(cause.contradictingEvidence.some((c) => /not fully deterministic/.test(c.note))).toBe(true);
  });

  it('detects a placeholder removed before content is ready', () => {
    const t = new TimelineBuilder();
    t.at(0).navigate();
    t.at(5).visibility('loading', LOADER, true);
    const r = t.at(10).request('http://app.test/api/slow-data');
    t.at(100).visibility('loading', LOADER, false);
    t.at(500).respond(r);
    t.at(502).visibility('content', CONTENT, true);
    const analysis = analyzeEvidence(
      input(t, { issueDescription: 'The list area is blank for a moment before items appear' }),
    );
    const cause = analysis.candidateRootCauses.find((c) => c.kind === 'premature_loader_removal');
    expect(cause).toBeDefined();
    expect(cause!.confidence.level).toBe('medium');
    expect(analysis.reproduction.status).toBe('reproduced');
  });

  it('treats uncaught errors as facts but qualifies their causal role', () => {
    const t = new TimelineBuilder();
    t.at(0).navigate();
    t.at(50).pageError("Cannot read properties of undefined (reading 'title')");
    t.at(60).visibility('content', CONTENT, true);
    const analysis = analyzeEvidence(
      input(t, { issueDescription: 'Uncaught TypeError when opening the page' }),
    );
    const cause = analysis.candidateRootCauses.find((c) => c.kind === 'uncaught_exception')!;
    expect(cause.contradictingEvidence[0]!.note).toMatch(/did not prevent rendering/);
    expect(cause.confidence.level).toBe('low');
    expect(analysis.reproduction.status).toBe('reproduced');
  });

  it('counts a later successful retry as contradicting a failed request', () => {
    const t = new TimelineBuilder();
    t.at(0).navigate();
    const a = t.at(10).request('http://app.test/api/items');
    t.at(20).respond(a, 503);
    const b = t.at(30).request('http://app.test/api/items');
    t.at(40).respond(b, 200);
    const analysis = analyzeEvidence(input(t, { issueDescription: 'Items API request fails' }));
    const cause = analysis.candidateRootCauses.find((c) => c.kind === 'failed_request')!;
    expect(cause.contradictingEvidence.some((c) => /later request .* succeeded/.test(c.note))).toBe(true);
  });

  it('attributes blocked requests to the investigation environment', () => {
    const t = new TimelineBuilder();
    t.at(0).navigate();
    t.at(5).security('10.0.0.8');
    const r = t.at(6).request('http://10.0.0.8/api');
    t.at(7).respond(r, 403, true);
    const analysis = analyzeEvidence(input(t, { issueDescription: 'API request fails' }));
    expect(analysis.candidateRootCauses.some((c) => c.kind === 'failed_request')).toBe(false);
    expect(analysis.candidateRootCauses.find((c) => c.kind === 'environment_blocked')?.category).toBe(
      'investigation-environment',
    );
    expect(analysis.limitations.some((l) => /blocked by the investigator/.test(l))).toBe(true);
  });

  it('treats a refused main document (WAF/bot block) as environment, not as a reproduced bug', () => {
    const t = new TimelineBuilder();
    const doc = t.at(0).request('http://app.test/catalog', 'GET', 'document');
    t.at(5).navigate('http://app.test/catalog');
    t.at(10).respond(doc, 403);
    t.at(12).consoleError('Failed to load resource: the server responded with a status of 403 (Forbidden)');
    const analysis = analyzeEvidence(
      input(t, {
        issueDescription: 'Health check: console errors and failed network requests on load',
        initialNavigation: {
          ok: false,
          status: 403,
          finalUrl: 'http://app.test/catalog',
          durationMs: 10,
          blockedByPolicy: false,
        },
      }),
    );
    expect(analysis.reproduction.status).toBe('inconclusive');
    expect(analysis.reproduction.basis).toMatch(/refused to serve the page/);
    expect(analysis.candidateRootCauses.map((c) => c.kind)).toEqual(['access_denied']);
    expect(analysis.candidateRootCauses[0]!.category).toBe('investigation-environment');
  });

  it('does not treat aborted requests as failures', () => {
    const t = new TimelineBuilder();
    t.at(0).navigate();
    const video = t.at(10).request('http://app.test/intro.mp4', 'GET', 'media');
    t.at(50).fail(video, 'net::ERR_ABORTED');
    const analysis = analyzeEvidence(
      input(t, { issueDescription: 'Requests fail on load', steps: [step(1, 'succeeded')] }),
    );
    expect(analysis.candidateRootCauses).toEqual([]);
    expect(analysis.reproduction.status).toBe('not_reproduced');
    expect(analysis.observedFacts.some((f) => /aborted/.test(f.statement))).toBe(true);
  });

  it('adds contradicting evidence for 401s in a logged-out session and for third-party hosts', () => {
    const t = new TimelineBuilder();
    t.at(0).navigate();
    const me = t.at(10).request('http://app.test/api/me');
    t.at(20).respond(me, 401);
    const pixel = t.at(30).request('https://pixel.tracker.example/kpi', 'GET', 'image');
    t.at(40).fail(pixel, 'net::ERR_TUNNEL_CONNECTION_FAILED');
    const causes = analyzeEvidence(input(t, { issueDescription: 'Requests fail' })).candidateRootCauses;
    const me401 = causes.find((c) => c.title.includes('/api/me'))!;
    const tracker = causes.find((c) => c.title.includes('tracker.example'))!;
    expect(me401.contradictingEvidence.some((c) => /logged-out/.test(c.note))).toBe(true);
    expect(me401.confidence.level).toBe('low');
    expect(tracker.contradictingEvidence.some((c) => /third-party/.test(c.note))).toBe(true);
    expect(tracker.confidence.level).toBe('low');
  });

  it('flags "Failed to fetch" errors that follow requests blocked by the investigator', () => {
    const t = new TimelineBuilder();
    t.at(0).navigate();
    t.at(100).security('app.test');
    t.at(150).pageError('Failed to fetch', 'Uncaught (in promise) TypeError');
    const cause = analyzeEvidence(
      input(t, { issueDescription: 'JavaScript error on load' }),
    ).candidateRootCauses.find((c) => c.kind === 'uncaught_exception')!;
    expect(cause.title).toBe('Unhandled promise rejection TypeError: Failed to fetch');
    expect(cause.contradictingEvidence[0]!.note).toMatch(/side effect of the investigation/);
    expect(cause.confidence.level).toBe('low');
  });

  it('ranks investigation-environment causes after application causes', () => {
    const t = new TimelineBuilder();
    t.at(0).navigate();
    t.at(5).security('tracker.example.net');
    const r = t.at(10).request('http://app.test/img.jpg', 'GET', 'image');
    t.at(20).respond(r, 404);
    const analysis = analyzeEvidence(input(t, { issueDescription: 'Images fail to load' }));
    expect(analysis.candidateRootCauses[0]!.kind).toBe('failed_request');
    expect(analysis.candidateRootCauses.at(-1)!.kind).toBe('environment_blocked');
  });

  it('does not treat Chromium "Failed to load resource" console errors as JS errors', () => {
    const t = new TimelineBuilder();
    t.at(0).navigate();
    t.at(10).consoleError('Failed to load resource: the server responded with a status of 404 (Not Found)');
    const analysis = analyzeEvidence(
      input(t, { issueDescription: 'JavaScript error on load', steps: [step(1, 'succeeded')] }),
    );
    expect(analysis.reproduction.observedSymptoms).not.toContain('js_error');
  });

  it('is inconclusive when the description maps to no observable symptom', () => {
    const analysis = analyzeEvidence(input(flickerTimeline(), { issueDescription: 'Colors look odd' }));
    expect(analysis.reproduction.status).toBe('inconclusive');
  });

  it('is inconclusive (not "not reproduced") when steps failed', () => {
    const t = new TimelineBuilder();
    t.at(0).navigate();
    const analysis = analyzeEvidence(
      input(t, { steps: [step(1, 'succeeded'), step(2, 'timed_out', 'waitFor')] }),
    );
    expect(analysis.reproduction.status).toBe('inconclusive');
    expect(analysis.reproduction.basis).toMatch(/#2 timed_out/);
  });

  it('is inconclusive for a flicker report when no loading indicator was observed', () => {
    const t = new TimelineBuilder();
    t.at(0).navigate();
    const analysis = analyzeEvidence(input(t, { watch: { loading: [], content: [], heuristics: true } }));
    expect(analysis.reproduction.status).toBe('inconclusive');
    expect(analysis.additionalExperiments.some((e) => /watch\.loading/.test(e))).toBe(true);
  });

  it('lowers confidence when loaders were only found heuristically', () => {
    const t = new TimelineBuilder();
    t.at(0).navigate();
    t.at(5).visibility('loading', '[class*="spinner" i]', true, true);
    t.at(100).visibility('loading', '[class*="spinner" i]', false, true);
    t.at(300).visibility('loading', '[class*="spinner" i]', true, true);
    const analysis = analyzeEvidence(input(t, { watch: { loading: [], content: [], heuristics: true } }));
    const cause = analysis.candidateRootCauses[0]!;
    expect(cause.confidence.level).toBe('low');
    expect(analysis.limitations.some((l) => /heuristics/.test(l))).toBe(true);
  });
});
