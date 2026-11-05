# Tracekit tool reference

All tools validate their input strictly; unknown fields are rejected. Errors start with a stable code: `INVALID_INPUT`, `URL_REJECTED`, `NOT_FOUND`, `INVALID_STATE`, `BUSY`, `LIMIT_REACHED`, `BROWSER_ERROR`, `INTERNAL`.

## start_investigation

| Field                            | Notes                                                                                                       |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `targetUrl` (required)           | `http` or `https` only.                                                                                     |
| `issueDescription` (required)    | The bug in plain language. Used for the report and for matching symptoms.                                   |
| `stepsToReproduce`               | Plain-language steps, recorded in the report (not executed).                                                |
| `expectedBehavior`               | What should happen instead.                                                                                 |
| `watch.loading`, `watch.content` | Up to 10 CSS selectors each. Needed for flicker and placeholder bugs.                                       |
| `watch.heuristics`               | Also track common loading patterns (`aria-busy`, progress bars, `*loading*`, `*skeleton*`). Default `true`. |
| `waitUntil`                      | `load` (default), `domcontentloaded`, `networkidle`, `commit`.                                              |
| `viewport`                       | `{ "width": 1280, "height": 800 }` by default.                                                              |
| `maxDurationSeconds`             | 10 to 3600; the server may set a lower limit.                                                               |

Returns `investigationId`, the navigation result and a deadline.

## reproduce_issue

`{ "investigationId": "...", "steps": [ ... ], "continueOnFailure": false }`, with 1 to 50 steps:

```jsonc
{ "action": "navigate", "url": "https://...", "waitUntil": "load" }
{ "action": "click", "target": { "by": "role", "role": "button", "name": "Refresh" } }
{ "action": "fill", "target": { "by": "label", "label": "Search" }, "value": "mug" }
{ "action": "select", "target": { "by": "testId", "testId": "sort" }, "option": { "label": "Price" } }
{ "action": "reload", "waitUntil": "networkidle" }
{ "action": "waitFor", "target": { "by": "text", "text": "Results" }, "state": "visible" }
{ "action": "screenshot", "label": "after refresh", "returnImage": true }
```

Locators (`target.by`): `role` (with optional `name`, `exact`), `text`, `label`, `placeholder`, `testId`, `css`. Every step accepts `timeoutMs` (100 to 300000).

Step status is `succeeded`, `failed`, `timed_out`, `blocked` (refused by the safety policy) or `skipped` (after an earlier failure). A failed step automatically captures a screenshot.

## collect_evidence

`{ "investigationId": "...", "categories": [...], "sinceSeq": 0, "limit": 100, "captureScreenshot": false }`

Categories: `console`, `page_error`, `network_request`, `network_response`, `network_failure`, `navigation`, `dom_visibility`, `layout_shift`, `screenshot`, `action`, `security`, `instrumentation`.

Returns items plus a compact `timeline`. Use `nextSinceSeq` to page through results.

## analyze_evidence

`{ "investigationId": "...", "additionalContext": "optional, e.g. recent code changes" }`

Returns `reproduction` (status and basis), `observedFacts`, `candidateRootCauses` (each with supporting and contradicting evidence and an explained confidence), `additionalExperiments` and `limitations`. The analysis is rule-based; the server does not use an LLM.

## generate_bug_report

`{ "investigationId": "..." }`: a structured JSON report, also saved as `report.json` in the artifacts folder.

## generate_regression_test

`{ "investigationId": "...", "testName": "optional" }`: Playwright TypeScript code plus its assertions and assumptions. The server never runs it; you or the user must.

## close_investigation

`{ "investigationId": "..." }`: releases the browser. Evidence stays available for analysis and reports for the retention period (one hour by default).
