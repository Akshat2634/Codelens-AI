# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 0.10.x  | Yes       |
| < 0.10  | No        |

Upgrade to the latest published patch before reporting a vulnerability.

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

1. **Do not open a public issue.**
2. Use [GitHub Security Advisories](https://github.com/Akshat2634/Codelens-AI/security/advisories/new) to report it privately.
3. Include a description, minimal reproduction steps, and impact assessment.
4. Do not attach raw agent session files. Remove prompts, responses, repository content, private paths, tokens, and credentials from any supporting material.

You will receive an initial response within 48 hours.

## Local Data Access

Codelens AI reads supported agent data from these locations by default:

- Claude Code: `~/.claude/projects/`
- OpenAI Codex CLI: `~/.codex/sessions/` or `$CODEX_HOME/sessions/`
- GitHub Copilot CLI: `~/.copilot/session-state/` or `$COPILOT_HOME/session-state/`
- GitHub Copilot in VS Code: the official Copilot Chat session files under VS Code's local `workspaceStorage/`

These source files can contain prompts, responses, private file paths, and repository information. Codelens AI reads them locally and does not place prompt or response text in its cache. Treat raw session files as sensitive and do not upload them to issues.

## Scope

This tool:

- Reads the local session locations above and local Git history.
- Runs a local HTTP server bound to `127.0.0.1` by default. Passing `--host 0.0.0.0` opts into network exposure.
- Stores parsed usage and correlation metadata at `~/.cache/agent-analytics/`.
- Writes exports only when an export path is requested.
- Writes a `statusLine` entry to `~/.claude/settings.json` only when `codelens-ai statusline --install` is run, after creating a backup.
- Serves Chart.js from a bundled local copy. The dashboard's only external browser request is for Google Fonts when online.

## Known Limitations

- The local server does not use HTTPS or authentication.
- Parsed metadata and reports can contain local paths and repository names.
- Exposing the server with `--host 0.0.0.0` can make dashboard data visible to other devices on the network.
