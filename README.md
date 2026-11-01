# Frontend Bug Investigator MCP

An MCP server for **investigating frontend bugs**, not for general browser automation.

An AI client describes a bug ("after refreshing the catalog page a loading placeholder briefly covers the content"). The
server then:

1. opens the page in an isolated, policy-restricted Chromium context,
2. runs a small, explicit set of reproduction actions,
3. records sanitized, timestamped evidence: console, uncaught errors, network status and timing, navigation,
   loading/content visibility over time, layout shifts, and screenshots,
4. separates **observed facts** from **candidate causes**, listing supporting _and_ contradicting evidence with an
   explained confidence,
5. produces a structured JSON bug report and a reviewable **Playwright regression test**.

It never claims a bug was reproduced unless the evidence shows the reported symptom, and it never treats a temporal
correlation as proof of causation.

---

## Quick start

Requirements: Node.js ≥ 22.12, npm.

```bash
npm install
npm run browsers:install   # downloads Playwright's Chromium
npm run build
npm run demo               # full end-to-end demonstration (see below)
```

### Connect an MCP client

The server speaks MCP over **stdio**.

Claude Code:

```bash
claude mcp add frontend-bug-investigator \
  -e INVESTIGATOR_ALLOWED_LOCAL_ORIGINS=http://127.0.0.1:4173 \
  -- node /absolute/path/to/repo/dist/index.js
```

Generic `mcpServers` configuration (Claude Desktop and similar clients):

```json
{
  "mcpServers": {
    "frontend-bug-investigator": {
      "command": "node",
      "args": ["/absolute/path/to/repo/dist/index.js"],
      "env": {
        "INVESTIGATOR_ALLOWED_HOSTS": "staging.example.com,*.cdn.example.com",
        "INVESTIGATOR_ALLOWED_LOCAL_ORIGINS": "http://127.0.0.1:4173"
      }
    }
  }
}
```

For debugging you can use the MCP Inspector: `npx @modelcontextprotocol/inspector node dist/index.js`.

---

## The demo (single documented workflow)

`npm run demo` runs `scripts/run-demo.ts`, which:

1. starts the **faulty catalog app** in buggy mode (`examples/faulty-catalog-app`, defect documented in its
   [README](examples/faulty-catalog-app/README.md)),
2. starts the MCP server (`dist/index.js`) as a child process over stdio,
3. connects an MCP client (`@modelcontextprotocol/client`) and lists the tools,
4. runs an investigation: `start_investigation` → `reproduce_issue` → `collect_evidence` → `analyze_evidence`,
5. writes the bug report to `demo-output/bug-report.json`,
6. writes the generated test to `demo-output/tests/*.spec.ts`,
7. runs that test with `@playwright/test` against the **buggy** app (it must **fail**), restarts the app in **fixed**
   mode, and runs it again (it must **pass**).

The script exits non-zero if any of these expectations is not met. Typical output:

```
analyze_evidence -> reproduction: reproduced
  cause_1 [medium] Loading state is re-entered after content has rendered
  cause_2 [low] Request failure: GET http://127.0.0.1:4173/api/banner
...
Regression test before fix: FAILED (as expected)
Regression test after fix:  PASSED (as expected)
```

The unrelated `/api/banner` 404 is reported, but ranked below the flicker, with contradicting evidence ("content became
visible after the failure", "not temporally aligned with the re-appearance").

A complete report from this workflow is committed as
[`examples/sample-investigation-report.json`](examples/sample-investigation-report.json). Regenerate it with
`npm run demo -- --update-sample`.

Run the demo app on its own with `npm run demo:app` (buggy) or `npm run demo:app -- --mode=fixed`.

---

## Tools

All tools validate input with strict Zod schemas (unknown properties are rejected). They return `structuredContent`
matching a published `outputSchema`, plus the same JSON as text. Failures are MCP tool errors (`isError: true`) whose
text starts with a stable code: `INVALID_INPUT`, `URL_REJECTED`, `NOT_FOUND`, `INVALID_STATE`, `BUSY`,
`LIMIT_REACHED`, `BROWSER_ERROR`, `INTERNAL`.

| Tool                       | Purpose                                                                                                                                  |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `start_investigation`      | Validate the URL, create an isolated browser context, navigate, start recording. Returns `investigationId`, navigation status, deadline. |
| `reproduce_issue`          | Run ordered, allowlisted actions; returns the outcome of each step.                                                                      |
| `collect_evidence`         | Return sanitized evidence (filter by category, paginate with `sinceSeq`) plus a compact timeline.                                        |
| `analyze_evidence`         | Deterministic analysis: facts, candidate causes, supporting/contradicting evidence, confidence, experiments.                             |
| `generate_bug_report`      | Structured JSON report; also exported as `report.json` in the artifacts directory.                                                       |
| `generate_regression_test` | Playwright test (TypeScript) for review. **Never executed by the server.**                                                               |
| `close_investigation`      | Release the browser context and proxy; evidence is kept until the retention period ends.                                                 |

### `start_investigation`

| Field                             | Type                                                      | Notes                                                                                                                            |
| --------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `targetUrl`                       | string                                                    | `http`/`https` only; checked against the egress policy (DNS included).                                                           |
| `issueDescription`                | string ≤ 4000                                             | Used for the report and for symptom matching.                                                                                    |
| `stepsToReproduce`                | string[]                                                  | Human-written steps, recorded in the report (use `reproduce_issue` to execute).                                                  |
| `expectedBehavior`                | string                                                    | Optional; otherwise inferred from the symptom class and labelled `inferred`.                                                     |
| `maxDurationSeconds`              | 10–3600                                                   | Hard deadline; bounded by `INVESTIGATOR_MAX_DURATION_SECONDS`.                                                                   |
| `viewport`                        | `{width, height}`                                         | Default 1280×800.                                                                                                                |
| `watch.loading` / `watch.content` | CSS selectors (≤ 10 each)                                 | Elements whose visibility is tracked over time. **Needed for flicker/placeholder bugs.**                                         |
| `watch.heuristics`                | boolean                                                   | Also track common loading patterns (`aria-busy`, `progressbar`, `*loading*`, `*skeleton*`, …). Default `true`.                   |
| `waitUntil`                       | `load` \| `domcontentloaded` \| `networkidle` \| `commit` | `networkidle` is an optional settle phase; a page that never becomes idle is reported (`networkIdleReached: false`), not failed. |

### `reproduce_issue` actions

The complete action set. There is no `evaluate`, arbitrary key press, or upload action.

```jsonc
{ "action": "navigate", "url": "https://…", "waitUntil": "load", "timeoutMs": 10000 }
{ "action": "click",    "target": { "by": "role", "role": "button", "name": "Refresh" } }
{ "action": "fill",     "target": { "by": "label", "label": "Search" }, "value": "mug" }
{ "action": "select",   "target": { "by": "testId", "testId": "sort" }, "option": { "label": "Price" } }
{ "action": "reload",   "waitUntil": "networkidle" }
{ "action": "waitFor",  "target": { "by": "text", "text": "Results" }, "state": "visible" }
{ "action": "screenshot", "label": "after refresh", "returnImage": true }
```

Locators (`target.by`): `role` (ARIA role + accessible name), `text`, `label`, `placeholder`, `testId`, and `css`
as the escape hatch. CSS selectors may not use Playwright selector engines (`xpath=`, `text=`, `internal:`), `>>`
chaining, or XPath. Each step has its own timeout, clipped to the investigation's remaining time. After a failed step
the remaining steps are `skipped` (unless `continueOnFailure: true`), and a screenshot of the failure is captured.

Fill values are kept only in memory, for test generation. Evidence and reports record only the value's length.

### Typical client flow

```
start_investigation {targetUrl, issueDescription, watch:{loading:[…], content:[…]}, waitUntil:"networkidle"}
reproduce_issue     {investigationId, steps:[{action:"reload", waitUntil:"networkidle"}, {action:"screenshot"}]}
collect_evidence    {investigationId, categories:["dom_visibility","network_response","console","page_error"]}
analyze_evidence    {investigationId}
generate_bug_report {investigationId}
generate_regression_test {investigationId}
close_investigation {investigationId}
```

---

## Architecture

```
MCP client ──stdio──► server/ (McpServer, serveStdio)
                        │
                        ▼
                     tools/ (Zod contracts, error mapping)
                        │
                        ▼
              investigations/InvestigationManager ── state machine, deadlines, limits, retention, cleanup
                 │                 │                     │
                 ▼                 ▼                     ▼
          browser/Session    evidence/Store        diagnosis/ + reports/
          (Playwright ctx,   (bounded, per         (pure functions over evidence:
           in-page observer,  category, raw         facts → hypotheses → report/test)
           actions)           observations only)
                 │
                 ▼
          security/EgressProxy ◄── security/EgressPolicy (URL, DNS, IP classes, allowlists)
                 │
                 ▼
             target app
```

```
src/
  index.ts                  stdio entry point, signal/stdin shutdown
  server/createServer.ts    wiring (dependency injection) and McpServer factory
  tools/                    input/output schemas, tool registration, error mapping
  investigations/           InvestigationManager (lifecycle), record types
  browser/                  Chromium provider, PlaywrightSession, locators, in-page observer
  evidence/                 EvidenceStore, normalization, summaries
  diagnosis/                symptom inference, rule-based analyzer, result schemas
  reports/                  bug report builder, regression test generator
  security/                 IP classification, egress policy, egress proxy, redaction
  config/ types/ util/      env config, shared types, errors, logger
tests/
  unit/                     policy, redaction, store, schemas, state machine, analyzer, reports, manager, proxy
  integration/              real Chromium against tests/fixtures/bugApp.ts and the demo app
  protocol/                 MCP over in-memory transport and over stdio
examples/
  faulty-catalog-app/       demo app (buggy/fixed modes)
  sample-investigation-report.json
scripts/run-demo.ts         end-to-end workflow
```

Design notes:

- **Raw evidence is separate from conclusions.** The store only holds observations, each with `id`, `investigationId`,
  `type`, `timestamp`, monotonic `elapsedMs`, redacted `url`, `source`, `untrusted`, and typed `details`.
  Analysis and reports are recomputed from evidence and reference it by id.
- **No hidden global state.** All state lives in an `InvestigationManager` instance. The session factory, DNS
  resolver, clock and browser provider are injected; unit and protocol tests run without a browser.
- **One browser, many contexts.** A single Chromium is launched lazily and closed when the last investigation ends.
  Each investigation gets its own `BrowserContext` (no persistent profile), its own egress proxy, and its own artifacts
  directory.
- **Flicker detection without arbitrary JS.** A fixed observer script, configured only with JSON data (the watch
  selectors), reports visibility transitions and layout shifts through a per-investigation random binding. Its reports
  are schema-validated and labelled `page-instrumentation` / `untrusted`.

### Evidence categories

`console` (errors and warnings, consecutive duplicates folded), `page_error`, `network_request` / `network_response`
(documents and fetch/XHR always; other resources only when they fail), `network_failure`, `navigation` (main-frame
navigations, load events, closed popups, dismissed dialogs, blocked downloads), `dom_visibility`, `layout_shift`,
`screenshot`, `action`, `security` (everything the investigator blocked), `instrumentation`.

Each category has its own cap (for example 200 console, 500 requests, 400 visibility events). When a cap is reached,
**new** items in that category are dropped and counted. The first occurrences are kept, because they usually surround
the onset of a bug, and one noisy category cannot evict another. Dropped counts appear in evidence results and in
report limitations.

### Diagnosis

`analyze_evidence` applies explicit rules (thresholds are in `src/diagnosis/analyzer.ts`):

| Candidate                             | Evidence used                                                                                                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `loading_state_reentered`             | loader visible again after content was visible; API request starting as it appears and finishing as it hides; preceding "trigger" response; duplicate requests to one endpoint |
| `premature_loader_removal`            | loader hidden while content not visible (gap ≥ 50 ms); requests in flight during the gap                                                                                       |
| `out_of_order_responses`              | later request to the same endpoint completing first                                                                                                                            |
| `uncaught_exception`                  | page errors; proximity to responses (labelled as proximity only); content rendering afterwards counts against                                                                  |
| `failed_request`                      | HTTP ≥ 400 or network failure; later success of the same endpoint, or content rendering anyway, counts against                                                                 |
| `slow_response`, `layout_instability` | duration ≥ 1 s; CLS ≥ 0.1                                                                                                                                                      |
| `environment_blocked`                 | requests blocked by the investigator itself, so failures may be artifacts of the investigation                                                                                 |
| `access_denied`                       | the main document returned 401/403/429 (typically CDN/WAF bot protection); reproduction becomes `inconclusive` because the app was never observed                              |

Confidence is `low` / `medium` / `high`, always with an explanation. Conclusions resting on correlation alone are
capped at `medium`, and the suggested experiments describe how to test causation (for example "delay the trigger
response and check whether the flicker moves with it"). No LLM is used by the server (`llmUsed: false`); the AI client
reasons on top of the structured output.

**Reproduction status** is `reproduced` only if an observed anomaly falls into a symptom class that the issue
description maps to (keyword-based, e.g. _flicker/placeholder/spinner_ → `loading_flicker`). It is `not_reproduced`
only when every step succeeded and nothing matching was observed. Everything else is `inconclusive`: failed steps, no
mappable description, a flicker report without any observable loading indicator, or dropped evidence. The basis is
always stated.

### Regression tests

`generate_regression_test` emits assertions only for anomalies that match the reported symptom:

- **Flicker:** an init script records loading/content visibility on every DOM mutation. The test fails if the loader
  becomes visible after content was shown, so transient flicker is caught even when the final state looks correct.
- **Premature loader removal:** fails if the loader disappears while content is not visible.
- **Uncaught errors / failed endpoints:** collects `pageerror` and failing responses for the endpoints that failed
  during the investigation.

It replays only steps that succeeded and prefers `getByRole`/`getByTestId`/`getByLabel`, converting
`[data-testid=…]` CSS to `getByTestId`. Instead of sleeping, it waits with a bounded `networkidle` derived from the
observed timing. Sensitive fill values become `process.env.TEST_INPUT_n`. Every assumption is listed in the file
header and in the `assumptions` field. If nothing relevant was observed, it returns a smoke test and says plainly that
the test will probably not detect the regression.

---

## Configuration

Environment variables (see [`.env.example`](.env.example)):

| Variable                                                          | Default                                     | Meaning                                                                                             |
| ----------------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `INVESTIGATOR_ALLOWED_HOSTS`                                      | _(empty = any public host)_                 | Comma-separated host patterns (`example.com`, `*.example.com`). Applies to **all** browser traffic. |
| `INVESTIGATOR_ALLOWED_LOCAL_ORIGINS`                              | _(empty)_                                   | Exact origins allowed to resolve to private/loopback addresses, e.g. `http://127.0.0.1:4173`.       |
| `INVESTIGATOR_ALLOW_MUTATING_REQUESTS`                            | `false`                                     | Allow POST/PUT/PATCH/DELETE and clicks on destructive-looking controls.                             |
| `INVESTIGATOR_MAX_CONCURRENT`                                     | `2`                                         | Active investigations (browser contexts).                                                           |
| `INVESTIGATOR_MAX_RETAINED`                                       | `20`                                        | Investigations kept in memory, active or finished (oldest finished are evicted).                    |
| `INVESTIGATOR_DEFAULT_DURATION_SECONDS` / `_MAX_DURATION_SECONDS` | `300` / `900`                               | Investigation deadline.                                                                             |
| `INVESTIGATOR_RETENTION_SECONDS`                                  | `3600`                                      | How long finished investigations and their artifacts are kept.                                      |
| `INVESTIGATOR_ACTION_TIMEOUT_MS` / `_MAX_ACTION_TIMEOUT_MS`       | `10000` / `60000`                           | Per-step timeouts.                                                                                  |
| `INVESTIGATOR_MAX_SCREENSHOTS`                                    | `20`                                        | Per investigation.                                                                                  |
| `INVESTIGATOR_ARTIFACTS_DIR`                                      | `<tmp>/frontend-bug-investigator-artifacts` | Screenshots and exported reports.                                                                   |
| `INVESTIGATOR_HEADLESS`                                           | `true`                                      |                                                                                                     |
| `INVESTIGATOR_LOG_LEVEL`                                          | `info`                                      | `error`/`warn`/`info`/`debug`. JSON lines on **stderr**, truncated to 2 KB.                         |

Invalid configuration stops the server at startup with a clear message.

### Lifecycle and cleanup

States: `starting → ready ⇄ running → closed | failed | expired` (terminal states cannot be left).

- `reproduce_issue` on a `running` investigation returns `BUSY`. On a terminal one it returns `INVALID_STATE`, but
  evidence can still be collected, analyzed and reported.
- The global deadline expires the investigation and releases the browser even in the middle of a step. That step is
  reported as failed and later steps as skipped.
- Terminal investigations keep their evidence for `INVESTIGATOR_RETENTION_SECONDS`, then the investigation and its
  artifacts directory are deleted. A periodic sweep runs, and the oldest finished investigations are evicted when the
  retention cap is reached.
- On shutdown (SIGINT/SIGTERM or stdin closing) every browser context, proxy and the browser are closed. Artifacts are
  kept so the client can still read them. Directories older than the retention period are removed when the next server
  process starts (only `inv_<uuid>` directories are touched).
- Artifact paths are generated by the server only. Investigation ids are validated (`inv_<uuid>`) before any filesystem
  use, and directories are created with mode `0700` (no effect on Windows ACLs).

---

## Security model

The target application, its content, and everything the browser reports are **untrusted**.

**Network egress (SSRF protection)**

- Only `http:`/`https:` URLs. URLs with embedded credentials are rejected.
- Every investigation runs its browser context through its **own authenticated forward proxy** on loopback
  (`src/security/egressProxy.ts`). Each connection is validated, including navigations, **every redirect hop**,
  subresources, fetch/XHR, page-initiated navigations and HTTPS/WSS `CONNECT` tunnels:
  - the host must match `INVESTIGATOR_ALLOWED_HOSTS` (if set),
  - internal-looking names are blocked (`localhost`, `*.local`, `*.internal`, single-label hosts, …),
  - the hostname is resolved and **every** returned address is classified. Loopback, private (RFC 1918), CGNAT,
    link-local, unique-local IPv6, multicast, reserved and documentation ranges are rejected, including IPv4-mapped,
    NAT64 and 6to4 forms,
  - cloud metadata addresses (`169.254.169.254`, `fd00:ec2::254`, `100.100.100.200`, …) are **always** blocked, even
    via local origins,
  - the proxy connects to the **exact IP it validated** instead of re-resolving, which closes the DNS-rebinding window
    between check and use (covered by tests).
- Chromium is launched with a placeholder proxy, so a context without its own proxy fails closed. WebRTC non-proxied
  UDP, DNS prefetch and QUIC are disabled. Service workers are blocked, downloads are disabled, popups are closed, and
  dialogs are dismissed.
- Local development servers must be listed explicitly by exact origin in `INVESTIGATOR_ALLOWED_LOCAL_ORIGINS`.

**Actions**

- Explicit action allowlist with strict schemas. No JavaScript evaluation from clients, no file uploads, and no
  Playwright selector engines in CSS selectors.
- State-changing requests (POST/PUT/PATCH/DELETE, including form submissions and beacons) are blocked by default, and
  clicks on controls labelled delete/remove/buy/pay/checkout/… are refused. Both are recorded as `security` evidence.
- Generated tests are returned as text and never executed by the server.

**Data handling**

- Evidence keeps only what debugging needs. Request/response bodies and request headers are never stored. Response
  headers are reduced to an allowlist (`content-type`, `cache-control`, `location`, …); cookies and auth headers are
  never kept.
- URLs: credentials and fragments are removed, and sensitive query values (`token`, `key`, `secret`, `password`,
  `session`, `code`, `state`, `signature`, …) are replaced with `[REDACTED]`.
- Free text (console, errors, stacks): bearer/basic credentials, JWTs, AWS/Stripe/GitHub/Slack-style keys,
  `key=value` secrets, cookies and e-mail addresses are redacted. Control, ANSI, zero-width and bidi characters are
  stripped, and lengths are bounded.

**Prompt injection**

- Page-derived fields are marked `untrusted: true`, and results carry an explicit notice to treat them as data.
- Console messages and errors that look like instructions to an AI agent are flagged (`possiblePromptInjection`).
  They are recorded, never acted upon. The server's own behaviour never depends on page text.

### Residual risks and limitations

Input validation and an in-process proxy reduce risk; they do **not** make the server "secure" on their own.

- **Use network-level egress controls for real isolation.** The proxy only governs traffic that Chromium routes
  through it. A Chromium bug, an unknown bypass, or a non-proxied protocol could reach the network directly. In
  production-like use, run the server in a container or VM with an egress firewall that only allows the intended
  targets, and with no access to cloud metadata endpoints.
- **Run as an unprivileged user with OS isolation.** Chromium executes untrusted page code. The server relies on
  Chromium's sandbox; it adds no additional OS sandbox.
- The proxy sees only host and port for HTTPS (no TLS interception), so method-level blocking for HTTPS relies on
  Playwright request routing inside the browser.
- Side effects through GET requests, or through clicks that trigger non-blocked behaviour, cannot be prevented in
  general. Point the investigator at test/staging environments and test accounts.
- The in-page observer runs inside the target page, which could tamper with it or send fake reports. Reports are
  validated and labelled, not trusted.
- The proxy marks its own synthetic responses with `X-Investigator-*` headers and strips such headers from upstream
  responses.
- Redaction is pattern-based and may miss unusual secret formats; screenshots are **not** redacted. Treat the artifacts
  directory as sensitive.
- If `INVESTIGATOR_ALLOWED_HOSTS` is empty, any public host is reachable. Set an allowlist whenever possible.

### Functional limitations

- Chromium only; one page per investigation (popups are closed).
- Visibility tracking needs selectors (or matching heuristics). Timestamps are investigator observation times, with
  millisecond-level skew between sources.
- Diagnosis is rule-based. It recognises the patterns listed above and makes no claims beyond them.
- Symptom matching between the description and the evidence is keyword-based, and the reproduction basis says so.

---

## Development

```bash
npm run typecheck        # tsc (strict) over src, tests, scripts, examples
npm run lint             # eslint (typescript-eslint)
npm run format:check     # prettier
npm test                 # all vitest suites (unit + integration + protocol)
npm run test:unit
npm run test:integration # launches Chromium; uses only local servers
npm run test:protocol    # MCP over in-memory transport and over stdio
npm run check            # typecheck + lint + test
npm run dev              # run the server from source with tsx
```

Integration tests use `tests/fixtures/bugApp.ts`, a local app with injected bugs (unhandled error, failed API calls, a
placeholder removed too early, delayed-response flicker, secrets in logs, a form, a popup), plus the demo app in both
modes. No public websites are used.

Stack: TypeScript 6 (strict, ESM/NodeNext), MCP TypeScript SDK v2 (`@modelcontextprotocol/server` /
`@modelcontextprotocol/client`), Playwright 1.64, Zod 4, Vitest 5. TypeScript is pinned to 6.0.x because
`typescript-eslint` does not support TypeScript 7 yet.

---

### Trying it on real websites

```bash
npm run live:check        # the-internet.herokuapp.com bug pages, control pages, SSRF checks with real DNS
npm run live:enterprise   # read-only health check (load + reload) of large public sites
npm run live:enterprise -- https://your-site.example/   # or any URLs you pass
```

Results go to `demo-output/live` and `demo-output/enterprise`. Many large sites (for example those behind Akamai Bot Manager) answer the headless browser with **403 Access Denied**. The investigator reports this as `access_denied` and does **not** try to bypass bot protection. For your own sites, use a staging environment or add a WAF rule that allows the investigator.

Rules added after running against production sites: `net::ERR_ABORTED` requests (cancelled by a navigation or the page) are not failures. A 401 in the investigator's logged-out session, a failure on a third-party host, and a `Failed to fetch` error shortly after the investigator blocked a request are recorded as contradicting evidence, which lowers confidence. Investigation-environment causes are always ranked after application causes.

## Troubleshooting

| Symptom                                                       | Cause / fix                                                                                                                           |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `BROWSER_ERROR: … Executable doesn't exist`                   | Run `npm run browsers:install`.                                                                                                       |
| `URL_REJECTED: … resolves to a non-public (loopback) address` | Add the exact origin (scheme, host, port) to `INVESTIGATOR_ALLOWED_LOCAL_ORIGINS`. `localhost` and `127.0.0.1` are different origins. |
| `URL_REJECTED: … not in INVESTIGATOR_ALLOWED_HOSTS`           | Add the host (or `*.domain`) to the allowlist.                                                                                        |
| Page loads but assets/APIs fail, `security` evidence present  | A dependency (CDN, API host) is not allowlisted. See `environment_blocked` in the analysis.                                           |
| `networkIdleReached: false` / step warning                    | The page keeps requests open (polling, streaming, unconsumed responses). Use `load` plus `waitFor` on a concrete element.             |
| Flicker report is `inconclusive`                              | Provide `watch.loading` and `watch.content` selectors so visibility can be observed.                                                  |
| `access_denied` / page shows "Access Denied"                  | The site's CDN/WAF blocks automated browsers. Use staging or allow the investigator in the WAF; bypassing is out of scope.            |
| `LIMIT_REACHED`                                               | Close finished investigations (`close_investigation`) or raise `INVESTIGATOR_MAX_CONCURRENT`.                                         |
| `BUSY`                                                        | A `reproduce_issue` call is still running for that investigation.                                                                     |
| Port 4173 in use during `npm run demo`                        | Set `DEMO_PORT` to another port.                                                                                                      |
| Nothing appears in the client / garbled protocol              | Make sure nothing writes to stdout; the server logs to stderr only.                                                                   |

---

## License

[MIT](LICENSE) © 2026 Batyr.

Runtime dependencies are licensed separately: the MCP TypeScript SDK and Playwright under Apache-2.0, Zod under MIT.
