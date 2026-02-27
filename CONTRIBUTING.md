# Contributing to claude-roi

Thank you for your interest in contributing to claude-roi! This guide will help you get started.

## How to Contribute

### Reporting Bugs

If you find a bug, please [open an issue](https://github.com/Akshat2634/Codelens-AI/issues/new?template=bug_report.md) with:

- A clear description of the problem
- Steps to reproduce
- Expected vs actual behavior
- Your Node.js version and OS

### Suggesting Features

Feature requests are welcome! Please [open a feature request](https://github.com/Akshat2634/Codelens-AI/issues/new?template=feature_request.md) describing:

- The problem you're trying to solve
- Your proposed solution
- Any alternatives you've considered

### Submitting Pull Requests

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Make your changes
4. Run the tests (see below)
5. Commit your changes with a descriptive message
6. Push to your fork and open a pull request

## Development Setup

### Prerequisites

- [Node.js](https://nodejs.org/) >= 18.0.0
- [Git](https://git-scm.com/)
- [Claude Code](https://claude.ai/code) (for generating session data to test against)

### Getting Started

```bash
# Clone your fork
git clone https://github.com/<your-username>/Codelens-AI.git
cd Codelens-AI

# Install dependencies
npm install

# Run the tool (opens dashboard in browser)
node src/index.js

# Run without opening browser (useful during development)
node src/index.js --no-open

# Output JSON data for debugging
node src/index.js --json | head -30
```

## Running Tests

```bash
# Run the full Playwright test suite
npm test

# Run a specific test file
npx playwright test tests/dashboard.spec.js

# Run tests with UI mode
npx playwright test --ui
```

Note: Tests require the dashboard server to be running with valid Claude Code session data. The test suite validates dashboard rendering, metrics display, and UI interactions.

## Project Structure

```
src/
  index.js          # CLI entry point and orchestration
  claude-parser.js  # Parses Claude Code JSONL session files
  git-analyzer.js   # Analyzes git history with branch awareness
  correlator.js     # Matches sessions to commits by file overlap / time
  metrics.js        # Computes ROI metrics, grades, and insights
  cache.js          # Incremental caching layer
  server.js         # Express API server
  dashboard.html    # Interactive single-page dashboard
tests/
  dashboard.spec.js # Playwright integration tests
```

## Code Style

- Use ES modules (`import`/`export`)
- Use `node:` prefix for built-in modules (e.g., `node:path`, `node:fs`)
- Keep functions focused and single-purpose
- Prefer descriptive variable names over comments

## Pull Request Guidelines

- Keep PRs focused on a single change
- Include a clear description of what changed and why
- Update the README if your change affects user-facing behavior
- Add tests for new functionality when possible
- Ensure existing tests still pass

## Contribution Ideas

Looking for something to work on? Here are some ideas:

- Support for other AI coding agents beyond Claude Code
- Export metrics to CSV/JSON
- Historical trend tracking across multiple runs
- Custom pricing overrides via config
- Additional visualization types in the dashboard
- Unit tests for core logic (parser, correlator, metrics)

## Questions?

If you have questions about contributing, feel free to [open a discussion](https://github.com/Akshat2634/Codelens-AI/issues) on GitHub.
