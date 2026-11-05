# Setting up the Tracekit MCP server

This skill needs the Tracekit MCP server running on your machine. The server is free and open source (MIT): https://github.com/Batyrkhan-Sk/tracekit-mcp

## Requirements

- Node.js 22.12 or newer (`node --version`).
- About 200 MB of disk space for the Chromium browser that the server drives.

## 1. Install the browser (once)

```bash
npx -y tracekit-mcp install-browser
```

This downloads the Chromium build that matches the server's Playwright version.

## 2. Register the server with your agent

Ready-made configuration files are in `assets/mcp-config/`.

**Claude Code** (one command):

```bash
claude mcp add tracekit -- npx -y tracekit-mcp
```

To share it with a team, add `assets/mcp-config/mcp.json` to the project as `.mcp.json`.

**Claude Desktop, Cursor, Windsurf and other `mcpServers`-style clients:** merge `assets/mcp-config/mcp.json` into the client's MCP configuration file (Cursor: `.cursor/mcp.json` or `~/.cursor/mcp.json`).

**VS Code / GitHub Copilot:** copy `assets/mcp-config/vscode-mcp.json` to `.vscode/mcp.json`.

**Codex CLI:** add the contents of `assets/mcp-config/codex-config.toml` to `~/.codex/config.toml`.

Restart the agent or start a new session afterwards, so the tools are loaded.

## 3. Allow the sites you want to investigate

By default the server can reach public websites only. Local and private addresses are blocked to prevent server-side request forgery.

| Setting                              | Use it for                                                                                                     | Example                                       |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `INVESTIGATOR_ALLOWED_LOCAL_ORIGINS` | Local dev servers. Exact origins: scheme, host and port must match; `localhost` and `127.0.0.1` are different. | `http://localhost:5173,http://127.0.0.1:3000` |
| `INVESTIGATOR_ALLOWED_HOSTS`         | Restricting the browser to your own sites (recommended). Include CDN and API hosts the page needs.             | `staging.example.com,*.example-cdn.com`       |

Set them in the `env` block of the configuration, or with Claude Code:

```bash
claude mcp add tracekit -e INVESTIGATOR_ALLOWED_LOCAL_ORIGINS=http://localhost:5173 -- npx -y tracekit-mcp
```

Other settings (timeouts, limits, artifacts folder) are documented in the project README.

## Troubleshooting

| Symptom                                            | Fix                                                                                                                                                                  |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The agent does not list the Tracekit tools         | Restart the agent; check the configuration file location; run `npx -y tracekit-mcp` in a terminal to see errors (it waits silently for an MCP client when it works). |
| "Chromium is not installed"                        | Run `npx -y tracekit-mcp install-browser`.                                                                                                                           |
| `URL_REJECTED … non-public (loopback) address`     | Add the exact origin to `INVESTIGATOR_ALLOWED_LOCAL_ORIGINS`.                                                                                                        |
| `URL_REJECTED … not in INVESTIGATOR_ALLOWED_HOSTS` | Add the host to the allowlist.                                                                                                                                       |
| `access_denied` in the analysis                    | The site's bot protection refuses automated browsers. Use a staging environment or ask the site owner for an allow rule.                                             |
| Windows: the client cannot start `npx`             | Use `"command": "cmd"` with `"args": ["/c", "npx", "-y", "tracekit-mcp"]`.                                                                                           |
