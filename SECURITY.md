# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 0.2.x   | Yes       |
| < 0.2   | No        |

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

- Reads local files from `~/.claude/projects/` (read-only)
- Runs a local HTTP server on localhost (not exposed to network by default)
- Stores cache at `~/.cache/claude-roi/`
- Loads Chart.js and Inter font from CDN in the dashboard

## Known Limitations

- The localhost server does not use HTTPS or authentication
- Session data may contain file paths from your projects
