# MCP configuration templates

Replace `http://localhost:5173` with the origin of your own dev server, or remove the line. Leave `INVESTIGATOR_ALLOWED_HOSTS` empty to allow any public host, or list your own hosts to restrict the browser to them.

| File                | Agent                                                   | Where it goes                                                                    |
| ------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `mcp.json`          | Claude Code (project), Claude Desktop, Cursor, Windsurf | `.mcp.json` in the project (Claude Code), the client's MCP config file otherwise |
| `vscode-mcp.json`   | VS Code / GitHub Copilot                                | `.vscode/mcp.json`                                                               |
| `codex-config.toml` | Codex CLI                                               | `~/.codex/config.toml`                                                           |

See `../../references/setup.md` for step-by-step instructions.
