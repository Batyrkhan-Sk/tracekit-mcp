# Safeguards

What the Tracekit MCP server does to keep investigations safe. Full details and remaining risks are in the project README: https://github.com/Batyrkhan-Sk/tracekit-mcp#security-model

## This skill package

- Contains only Markdown instructions and configuration templates. No scripts, binaries or bundled dependencies.
- Reads no environment variables and sends no data anywhere. The only network access happens in the separately installed MCP server, at the user's request.

## Network

- The browser can reach only `http` and `https` URLs.
- Each investigation routes all browser traffic through its own local, authenticated proxy. The proxy validates every connection, including every redirect hop:
  - Private, loopback, link-local and cloud-metadata addresses are blocked. Cloud metadata endpoints stay blocked even for explicitly allowed local origins.
  - DNS answers are checked, and the proxy connects only to the address it verified, which prevents DNS-rebinding tricks.
  - An optional host allowlist restricts the browser to the user's own sites.

## Actions

- Only seven explicit actions exist: navigate, click, fill, select, reload, waitFor, screenshot. There is no arbitrary JavaScript execution and no file upload.
- State-changing requests (POST, PUT, PATCH, DELETE, including form submissions) are blocked by default.
- Clicks on controls labelled delete, remove, buy, pay, checkout and similar are refused.
- Downloads are disabled, popups are closed, dialogs are dismissed.
- Generated regression tests are returned as text and never executed by the server.

## Data

- Request and response bodies are never stored.
- Cookies, authorization headers, tokens, sensitive URL parameters and e-mail addresses are redacted from the recorded evidence.
- Text coming from the investigated page is marked as untrusted. Instruction-like text in it is flagged and never acted upon.

## Resource limits

- Each investigation has a hard deadline, per-step timeouts, a cap on concurrent browsers, and bounded evidence storage.
- Finished investigations and their screenshots are deleted after a retention period.
