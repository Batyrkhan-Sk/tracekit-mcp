import { z } from 'zod';
import type { Analysis, CandidateCause } from '../diagnosis/types.js';
import type { InvestigationRecord } from '../investigations/record.js';
import { REDACTED } from '../security/redact.js';
import type { Action, LocatorSpec } from '../types/actions.js';

export const RegressionTestSchema = z.object({
  investigationId: z.string(),
  testName: z.string(),
  fileName: z.string(),
  framework: z.literal('@playwright/test'),
  language: z.literal('typescript'),
  code: z.string(),
  assertions: z.array(z.object({ description: z.string(), derivedFrom: z.array(z.string()) })),
  assumptions: z.array(z.string()),
  reproductionStatus: z.enum(['reproduced', 'not_reproduced', 'inconclusive']),
  executed: z.literal(false).describe('Generated code is never executed by the investigator'),
  reviewNotes: z.array(z.string()),
});
export type RegressionTest = z.infer<typeof RegressionTestSchema>;

const lit = (value: string) =>
  `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, '\\n')}'`;
const SENSITIVE_FIELD = /pass|secret|token|otp|pin|card|cvv|ssn|api.?key/i;

/** Converts `[data-testid="x"]`-style CSS into a test id when possible. */
function testIdFromCss(selector: string): string | null {
  const match = /^\s*\[data-testid\s*=\s*(?:"([^"]+)"|'([^']+)'|([\w-]+))\s*\]\s*$/.exec(selector);
  return match ? (match[1] ?? match[2] ?? match[3] ?? null) : null;
}

function cssLocatorCode(selector: string, assumptions: Set<string>): string {
  const testId = testIdFromCss(selector);
  if (testId) return `page.getByTestId(${lit(testId)})`;
  assumptions.add(
    `CSS selector ${lit(selector)} is used directly; prefer a role- or test-id-based locator if one exists.`,
  );
  return `page.locator(${lit(selector)})`;
}

function locatorCode(spec: LocatorSpec, assumptions: Set<string>): string {
  const exact = (e?: boolean) => (e ? ', exact: true' : '');
  switch (spec.by) {
    case 'role':
      return spec.name !== undefined
        ? `page.getByRole(${lit(spec.role)}, { name: ${lit(spec.name)}${exact(spec.exact)} })`
        : `page.getByRole(${lit(spec.role)})`;
    case 'text':
      return `page.getByText(${lit(spec.text)}${spec.exact ? ', { exact: true }' : ''})`;
    case 'label':
      return `page.getByLabel(${lit(spec.label)}${spec.exact ? ', { exact: true }' : ''})`;
    case 'placeholder':
      return `page.getByPlaceholder(${lit(spec.placeholder)}${spec.exact ? ', { exact: true }' : ''})`;
    case 'testId':
      return `page.getByTestId(${lit(spec.testId)})`;
    case 'css':
      return cssLocatorCode(spec.selector, assumptions);
  }
}

function urlCode(rawUrl: string, origin: string, assumptions: Set<string>): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return lit(rawUrl);
  }
  if (url.href.includes(REDACTED) || url.href.includes(encodeURIComponent(REDACTED))) {
    assumptions.add(
      'The URL contained sensitive parameters that were redacted during the investigation; replace the [REDACTED] placeholders.',
    );
  }
  if (url.origin === origin) return `new URL(${lit(`${url.pathname}${url.search}`)}, BASE_URL).href`;
  return lit(url.href);
}

function stepCode(
  action: Action,
  index: number,
  origin: string,
  assumptions: Set<string>,
  envVars: string[],
): string | null {
  switch (action.action) {
    case 'navigate':
      return `await page.goto(${urlCode(action.url, origin, assumptions)});`;
    case 'reload':
      return 'await page.reload();';
    case 'click':
      return `await ${locatorCode(action.target, assumptions)}.click();`;
    case 'fill': {
      const target = JSON.stringify(action.target);
      if (SENSITIVE_FIELD.test(target)) {
        const name = `TEST_INPUT_${index}`;
        envVars.push(name);
        assumptions.add(
          `The value for ${name} looked sensitive and was not embedded; provide it via the ${name} environment variable.`,
        );
        return `await ${locatorCode(action.target, assumptions)}.fill(process.env.${name} ?? '');`;
      }
      return `await ${locatorCode(action.target, assumptions)}.fill(${lit(action.value)});`;
    }
    case 'select':
      return `await ${locatorCode(action.target, assumptions)}.selectOption(${'value' in action.option ? `{ value: ${lit(action.option.value)} }` : `{ label: ${lit(action.option.label)} }`});`;
    case 'waitFor': {
      const loc = locatorCode(action.target, assumptions);
      const state = action.state ?? 'visible';
      if (state === 'visible') return `await expect(${loc}).toBeVisible();`;
      if (state === 'hidden') return `await expect(${loc}).toBeHidden();`;
      return `await ${loc}.waitFor({ state: ${lit(state)} });`;
    }
    case 'screenshot':
      return null;
  }
}

function commentBlock(lines: string[]): string {
  const safe = lines.map((l) => l.replace(/\*\//g, '* /').replace(/[\r\n]+/g, ' '));
  return ['/*', ...safe.map((l) => (l ? ` * ${l}` : ' *')), ' */'].join('\n');
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'regression'
  );
}

function observedSettleBound(record: InvestigationRecord): number {
  const timeline = record.store.timeline();
  let docStart: number | null = null;
  let longest = 0;
  for (const item of timeline) {
    if (item.type === 'navigation' && item.details.event === 'main_frame_navigated')
      docStart = item.elapsedMs;
    if (docStart !== null && (item.type === 'network_response' || item.type === 'network_failure')) {
      longest = Math.max(longest, item.elapsedMs - docStart);
    }
  }
  return Math.round(Math.min(15_000, Math.max(3_000, longest * 3)));
}

export interface RegressionTestOptions {
  testName?: string;
}

/**
 * Builds a reviewable Playwright test from an investigation. The test asserts
 * observable behaviour (DOM visibility over time, uncaught errors, HTTP
 * status) for the anomalies that match the reported symptom. It is returned
 * as text and never executed here.
 */
export function generateRegressionTest(
  record: InvestigationRecord,
  analysis: Analysis,
  options: RegressionTestOptions = {},
): RegressionTest {
  const assumptions = new Set<string>();
  const reviewNotes: string[] = [];
  const assertions: RegressionTest['assertions'] = [];
  const envVars: string[] = [];

  const target = new URL(record.targetUrl);
  const origin = target.origin;
  const inferred = analysis.reproduction.inferredSymptoms;
  const isRelevant = (c: CandidateCause) => c.symptomClasses.some((s) => inferred.includes(s));
  const causes = analysis.candidateRootCauses.filter((c) => c.category !== 'investigation-environment');
  const find = (kind: string) => causes.find((c) => c.kind === kind && isRelevant(c));

  const reentry = find('loading_state_reentered');
  const gap = find('premature_loader_removal');
  const exception = find('uncaught_exception');
  const failedRequests = causes.filter((c) => c.kind === 'failed_request' && isRelevant(c));

  // Selectors for the loading/content recorder.
  const observedHeuristic = record.store
    .ofType('dom_visibility')
    .find((v) => v.details.role === 'loading' && v.details.heuristic && v.details.visible)?.details.selector;
  const loadingSelector = record.watch.loading[0] ?? (reentry || gap ? observedHeuristic : undefined);
  const contentSelector = record.watch.content[0];
  if (!record.watch.loading.length && loadingSelector) {
    assumptions.add(
      `The loading indicator selector ${lit(loadingSelector)} was found by heuristics; confirm it identifies the placeholder from the issue.`,
    );
  }
  if (record.watch.loading.length > 1 || record.watch.content.length > 1) {
    assumptions.add('Only the first watched loading and content selectors are used by the test.');
  }

  const checkReappear = !!reentry && !!loadingSelector;
  const checkPrematureRemoval = !!gap && !!loadingSelector && !!contentSelector;
  const useRecorder = checkReappear || checkPrematureRemoval;

  const failingPaths = [
    ...new Set(
      failedRequests.flatMap((c) =>
        (c.supportingEvidence[0]?.evidenceIds ?? []).flatMap((id) => {
          const url = record.store.get(id)?.url;
          try {
            return url ? [new URL(url).pathname] : [];
          } catch {
            return [];
          }
        }),
      ),
    ),
  ];

  // Settle bound: 3x the longest observed document load (navigation -> last API response), clamped.
  const settleTimeoutMs = observedSettleBound(record);

  // ---- Test body ----
  const body: string[] = [];
  if (exception) {
    body.push(
      'const pageErrors: string[] = [];',
      "page.on('pageerror', (error) => pageErrors.push(error.message));",
    );
  }
  if (failingPaths.length) {
    body.push(
      `const failingEndpoints = [${failingPaths.map(lit).join(', ')}];`,
      'const failedResponses: string[] = [];',
      "page.on('response', (response) => {",
      '  const path = new URL(response.url()).pathname;',
      '  if (failingEndpoints.includes(path) && response.status() >= 400) failedResponses.push(`${response.status()} ${path}`);',
      '});',
    );
  }
  if (useRecorder) body.push('await trackLoadingStates(page);');
  if (body.length) body.push('');

  body.push(`await page.goto(${urlCode(record.targetUrl, origin, assumptions)});`);
  const replayed = record.steps.filter((s) => s.outcome.status === 'succeeded');
  const skipped = record.steps.length - replayed.length;
  if (skipped)
    assumptions.add(`${skipped} step(s) that did not succeed during the investigation were not replayed.`);
  for (const { action, outcome } of replayed) {
    const line = stepCode(action, outcome.index, origin, assumptions, envVars);
    if (line) body.push(line);
  }

  if (useRecorder || exception || failingPaths.length) {
    if (contentSelector) {
      const line = `await expect(${cssLocatorCode(contentSelector, assumptions)}).toBeVisible();`;
      if (body[body.length - 1] !== line) body.push(line);
    }
    body.push(
      '',
      '// Let the follow-up requests observed during the investigation settle before asserting.',
      '// networkidle is bounded: pages with long-lived requests never become idle.',
      "await page.waitForLoadState('networkidle', { timeout: SETTLE_TIMEOUT_MS }).catch(() => undefined);",
    );
    assumptions.add(
      `The test waits for 'networkidle' (bounded by SETTLE_TIMEOUT_MS = ${settleTimeoutMs}ms, derived from the observed timing) instead of a fixed sleep. If the page polls or streams, replace it with a wait for the specific response observed in the investigation.`,
    );
  }

  if (useRecorder) {
    body.push(`await expect(${cssLocatorCode(loadingSelector!, assumptions)}).toBeHidden();`);
    body.push(
      'const violations = await page.evaluate(() => (window as unknown as { __loadingStateViolations: string[] }).__loadingStateViolations);',
      'expect(violations, "loading/content visibility sequence").toEqual([]);',
    );
    if (checkReappear) {
      assertions.push({
        description: 'The loading indicator never becomes visible again after content has been shown.',
        derivedFrom: [reentry!.id, ...reentry!.supportingEvidence.flatMap((s) => s.evidenceIds).slice(0, 6)],
      });
    }
    if (checkPrematureRemoval) {
      assertions.push({
        description: 'The loading indicator is never removed while content is not yet visible.',
        derivedFrom: [gap!.id, ...gap!.supportingEvidence.flatMap((s) => s.evidenceIds).slice(0, 6)],
      });
    }
  }
  if (exception) {
    body.push('expect(pageErrors, "uncaught page errors").toEqual([]);');
    assertions.push({ description: 'No uncaught JavaScript errors occur.', derivedFrom: [exception.id] });
  }
  if (failingPaths.length) {
    body.push(
      'expect(failedResponses, "failed responses from endpoints that failed during the investigation").toEqual([]);',
    );
    assertions.push({
      description: `Requests to ${failingPaths.join(', ')} do not fail.`,
      derivedFrom: failedRequests.map((c) => c.id),
    });
  }

  if (!assertions.length) {
    // Nothing relevant observed: emit a smoke test and say so plainly.
    body.push('');
    body.push(
      'const pageErrors: string[] = [];',
      "page.on('pageerror', (error) => pageErrors.push(error.message));",
    );
    if (contentSelector)
      body.push(`await expect(${cssLocatorCode(contentSelector, assumptions)}).toBeVisible();`);
    body.push('expect(pageErrors).toEqual([]);');
    assertions.push({
      description: 'Smoke check: content is visible and no uncaught errors occur.',
      derivedFrom: [],
    });
    reviewNotes.push(
      'No anomaly matching the reported symptom was observed, so this is only a smoke test. It will probably NOT detect the reported regression; extend it once the bug is reproduced.',
    );
    if (!contentSelector)
      assumptions.add(
        'No content selector was watched, so the smoke test cannot assert that content is visible.',
      );
  }

  const testName =
    options.testName?.trim() ||
    (checkReappear
      ? 'loading placeholder does not re-appear after content is shown'
      : checkPrematureRemoval
        ? 'loading placeholder stays until content is visible'
        : exception
          ? 'page loads without uncaught errors'
          : failingPaths.length
            ? 'required requests succeed'
            : 'page loads and shows content');

  assumptions.add(
    `BASE_URL defaults to ${origin} (the investigated origin); set the BASE_URL environment variable to target another environment.`,
  );
  assumptions.add('Locators use Playwright defaults (getByTestId relies on the data-testid attribute).');
  assumptions.add(
    'The test asserts DOM visibility over time and HTTP outcomes, not implementation details; it has not been executed by the investigator.',
  );
  if (analysis.reproduction.status !== 'reproduced') {
    reviewNotes.push(
      `Reproduction status is "${analysis.reproduction.status}": the assertions are based on limited evidence. Confirm the test fails on the buggy build before relying on it.`,
    );
  } else {
    reviewNotes.push(
      'Run the test against the current (buggy) build first and confirm it fails for the expected reason before applying a fix.',
    );
  }

  const recorder = useRecorder
    ? [
        '',
        `const LOADING_SELECTOR = ${lit(loadingSelector!)};`,
        `const CONTENT_SELECTOR: string | null = ${contentSelector ? lit(contentSelector) : 'null'};`,
        '',
        '/**',
        ' * Records loading/content visibility after every DOM change so that a',
        ' * transient flicker is caught even when the final state looks correct.',
        ' */',
        'async function trackLoadingStates(page: Page): Promise<void> {',
        '  await page.addInitScript(',
        '    ({ loadingSelector, contentSelector, checkReappear, checkPrematureRemoval }) => {',
        '      const violations: string[] = [];',
        '      (window as unknown as { __loadingStateViolations: string[] }).__loadingStateViolations = violations;',
        '      const isVisible = (selector: string) =>',
        '        Array.from(document.querySelectorAll(selector)).some((el) => {',
        '          const style = getComputedStyle(el);',
        "          return el.getClientRects().length > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0;",
        '        });',
        '      let previous = { loading: false, content: false };',
        '      let contentShown = false;',
        '      let loaderHidden = false;',
        '      const check = () => {',
        '        const current = { loading: isVisible(loadingSelector), content: contentSelector ? isVisible(contentSelector) : false };',
        '        const t = Math.round(performance.now());',
        '        const shownBefore = contentSelector ? contentShown : loaderHidden;',
        '        if (checkReappear && current.loading && !previous.loading && shownBefore) {',
        '          violations.push(`loading indicator re-appeared after ${contentSelector ? "content was shown" : "it had been hidden"} (t=${t}ms)`);',
        '        }',
        '        if (checkPrematureRemoval && previous.loading && !current.loading && !current.content) {',
        '          violations.push(`loading indicator removed before content was visible (t=${t}ms)`);',
        '        }',
        '        if (current.content) contentShown = true;',
        '        if (previous.loading && !current.loading) loaderHidden = true;',
        '        previous = current;',
        '      };',
        '      new MutationObserver(check).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });',
        "      document.addEventListener('DOMContentLoaded', check);",
        '    },',
        `    { loadingSelector: LOADING_SELECTOR, contentSelector: CONTENT_SELECTOR, checkReappear: ${checkReappear}, checkPrematureRemoval: ${checkPrematureRemoval} },`,
        '  );',
        '}',
      ]
    : [];

  const header = commentBlock([
    'Regression test generated by frontend-bug-investigator-mcp.',
    `Investigation: ${record.id}`,
    `Issue: ${record.issueDescription.slice(0, 300)}`,
    `Reproduction status during investigation: ${analysis.reproduction.status}`,
    '',
    'REVIEW BEFORE USE. Assumptions:',
    ...[...assumptions].map((a) => `- ${a}`),
  ]);

  const code = [
    `import { test, expect${useRecorder ? ', type Page' : ''} } from '@playwright/test';`,
    '',
    header,
    '',
    `const BASE_URL = process.env.BASE_URL ?? ${lit(origin)};`,
    ...(useRecorder || exception || failingPaths.length
      ? [`const SETTLE_TIMEOUT_MS = ${settleTimeoutMs};`]
      : []),
    ...recorder,
    '',
    `test(${lit(testName)}, async ({ page }) => {`,
    ...body.map((l) => (l ? `  ${l}` : '')),
    '});',
    '',
  ].join('\n');

  return {
    investigationId: record.id,
    testName,
    fileName: `${slug(testName)}.spec.ts`,
    framework: '@playwright/test',
    language: 'typescript',
    code,
    assertions,
    assumptions: [...assumptions],
    reproductionStatus: analysis.reproduction.status,
    executed: false,
    reviewNotes,
  };
}
