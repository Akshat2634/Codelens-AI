# Contributing to Codelens AI

Thank you for helping improve Codelens AI. Keep pull requests focused and avoid including private agent-session data in issues, fixtures, logs, or screenshots.

## Reporting Bugs

Use the [structured bug report](https://github.com/Akshat2634/Codelens-AI/issues/new?template=bug_report.yml) and include reproducible steps, your Codelens AI and Node.js versions, operating system, and affected agent.

Do not upload raw session files, prompts, responses, private paths, repository content, tokens, or credentials. Redact logs and screenshots before attaching them. Report security problems through [private vulnerability reporting](https://github.com/Akshat2634/Codelens-AI/security/advisories/new), not a public issue.

## Suggesting Features

Open a [feature request](https://github.com/Akshat2634/Codelens-AI/issues/new?template=feature_request.md) describing the problem, proposed solution, and alternatives considered.

## Submitting Pull Requests

1. Fork the repository.
2. Create a focused branch.
3. Make the smallest change that solves the issue.
4. Add or update tests when behavior changes.
5. Run the validation commands below.
6. Use a [Conventional Commit](https://www.conventionalcommits.org/) subject such as `fix: handle missing session metadata` or `feat: add agent filter`.
7. Open a pull request and use `Closes #123` when it resolves an issue.

Conventional Commit prefixes drive Release Please: `fix:` creates a patch release, `feat:` creates a minor release, and a breaking-change marker creates a major release. Documentation and maintenance-only changes do not publish a new package by default.

## Development Setup

### Prerequisites

- [Node.js](https://nodejs.org/) 22.12.0 or newer
- [Git](https://git-scm.com/)
- Optional local data from Claude Code, OpenAI Codex CLI, GitHub Copilot CLI, or GitHub Copilot in VS Code when manually testing a parser

### Getting Started

```bash
git clone https://github.com/<your-username>/Codelens-AI.git
cd Codelens-AI
npm ci

node src/index.js --no-open
node src/index.js --json
```

Use the committed fixtures for automated tests. Never commit personal session files.

## Running Tests

```bash
npm run lint
npm run test:unit
npm run test:package
CI=1 npm run test:e2e
```

The package smoke test packs and installs the production tarball. The fixture-backed E2E suite installs and runs Chromium through Playwright. CI also runs unit and CLI smoke tests on macOS and Windows.

## Project Structure

```text
src/
  index.js                   CLI entry point and orchestration
  claude-parser.js           Claude Code session parser
  codex-parser.js            OpenAI Codex CLI session parser
  copilot-parser.js          GitHub Copilot CLI session parser
  copilot-vscode-parser.js   GitHub Copilot VS Code session parser
  git-analyzer.js            Git history and repository analysis
  correlator.js              Session-to-commit correlation
  metrics.js                 ROI metrics, grades, and insights
  pricing.js                 Provider and model pricing
  server.js                  Local Express API server
  dashboard.html             Interactive dashboard
  report.js                  Terminal, Markdown, and HTML reports
  mcp.js                     MCP server
  statusline.js              Claude Code statusline integration
scripts/
  smoke-package.mjs          Packed-package smoke test
  vendor-chart.mjs           Chart.js vendoring script
tests/
  unit/                      Node test-runner coverage
  e2e/                       Fixture-backed Playwright smoke tests
  local/                     Manual local-data Playwright tests
  fixtures/                  Synthetic agent-session fixtures
```

## Code Style

- Use ES modules and the `node:` prefix for built-in modules.
- Match the existing style and keep functions focused.
- Run Biome through `npm run lint` before opening a pull request.
- Keep behavior changes covered by targeted tests.
