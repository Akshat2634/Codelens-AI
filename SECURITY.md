# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 0.9.x   | Yes       |
| < 0.9   | No        |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

1. **Do NOT open a public issue.**
2. Use [GitHub Security Advisories](https://github.com/Akshat2634/Codelens-AI/security/advisories/new) to privately report the vulnerability.
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Impact assessment
4. You will receive a response within 48 hours.

## Scope

This tool:

- Reads local files from `~/.claude/projects/` and `~/.codex/sessions/` (read-only)
- Runs a local HTTP server bound to `127.0.0.1` by default (pass `--host 0.0.0.0` to opt in to network exposure)
- Stores cache at `~/.cache/agent-analytics/`
- `codelens-ai statusline --install` writes a `statusLine` entry to `~/.claude/settings.json` (after backing the file up); no other file outside the cache directory is ever written
- Serves Chart.js from a bundled local copy; the dashboard loads webfonts from Google Fonts (the only external request, and only when online)

## Known Limitations

- The localhost server does not use HTTPS or authentication
- Session data may contain file paths from your projects
