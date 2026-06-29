# CLAUDE.md — Codelens-AI

## Project Overview

**Codelens AI** (`codelens-ai` on npm) is a CLI tool that measures ROI from AI coding agents by correlating Claude Code token usage with git commit output. It parses Claude Code session files, analyzes git history, and serves an interactive dashboard at `http://localhost:3457`.

**Version:** 0.9.0
**License:** MIT
**npm package:** `codelens-ai` (alias: `claude-roi`)

## Tech Stack

- **Runtime:** Node.js >= 18, ES modules (`"type": "module"`)
- **Backend:** Express.js 5.0.0
- **CLI:** Commander.js 13.0.0
- **Frontend:** Single-file HTML (`src/dashboard.html`) with vanilla JS + locally-vendored Chart.js 4.5.1 (`src/vendor/`, served same-origin — no CDN)
- **Testing:** Playwright (E2E)
- **Styling:** Inline CSS with CSS variables, glassmorphism design, dark/light theme

## Project Structure

```
src/
├── index.js           # CLI entry point & orchestration (Commander)
├── claude-parser.js   # Parses JSONL session files from ~/.claude/projects/
├── git-analyzer.js    # Git log analysis, branch detection, diff stats
├── correlator.js      # Matches sessions to commits via file overlap + time window
├── metrics.js         # ROI calcs, grades, insights, cost-control, quality outcomes, streaks, waste
├── artifacts.js       # Weekly digest HTML + embeddable ROI badge generators
├── server.js          # Express REST API routes
├── cache.js           # Smart caching with stale file detection
├── dashboard.html     # Single-file SPA dashboard (Diagnostic vs Outcome)
└── vendor/            # Locally bundled Chart.js (no CDN)

tests/
├── unit/              # node:test unit tests (parser, correlator, metrics)
├── e2e/smoke.spec.js  # Playwright smoke suite (fixture-backed, runs in CI)
├── local/             # Full Playwright suite (local-only)
└── fixtures/          # Synthetic session fixtures + build-fixtures.js

.github/workflows/
├── ci.yml             # CI: syntax check, Node 18/20/22 matrix
└── release.yml        # npm publish on version tag push
```

## Data Flow

```
Claude Sessions (JSONL) → claude-parser.js → [Cache] → git-analyzer.js
→ correlator.js → metrics.js → server.js (REST API) → dashboard.html
```

## Key API Routes (server.js)

- `GET /` — dashboard HTML
- `GET /vendor/chart.umd.min.js` — locally vendored Chart.js (no CDN)
- `GET /api/all` — full payload (supports `?days=&project=` re-windowing)
- `GET /api/summary` — hero stats + insights
- `GET /api/timeline` — daily cost/output chart data
- `GET /api/sessions` — paginated sessions with sorting
- `GET /api/models` — model breakdown
- `GET /api/heatmap` — productivity heatmap (commits grid + cost by day-of-week)
- `GET /api/tools` — tool usage breakdown
- `GET /api/survival` — line survival stats (+ per-language)
- `GET /api/tokens` — detailed token analytics
- `GET /api/cost-control` — cache hit, premium-model share, subagent spend
- `GET /api/quality` — revert/rework/deletion outcomes
- `GET /api/waste` — high-burn + over-iteration sessions
- `GET /api/streaks` — coding streaks
- `GET /api/half-life` — git-blame survival (present only with `--blame`)
- `POST /api/refresh` — force re-parse

## CLI Usage

```bash
npx codelens-ai                 # defaults: 30 days, port 3457
npx codelens-ai --days 90       # custom lookback
npx codelens-ai --port 8080     # custom port
npx codelens-ai --no-open       # don't auto-open browser
npx codelens-ai --json          # dump raw JSON to stdout
npx codelens-ai --project X     # filter by project name
npx codelens-ai --refresh       # force full re-parse
npx claude-roi                  # backward-compatible alias
```

## Development Commands

```bash
npm install                     # install dependencies
npm test                        # run Playwright E2E tests (needs fixtures)
node src/index.js               # run locally
node --check src/*.js           # syntax validation
```

## Key Design Decisions

- **Single-file dashboard** — no build step, served directly by Express
- **Zero-config** — auto-discovers `~/.claude/projects/`
- **Smart caching** — incremental parsing, only re-processes changed JSONL files (`~/.cache/agent-analytics/`)
- **File-first correlation** — sessions matched to commits by file overlap, 2-hour temporal buffer
- **Privacy-first** — all data stays local, no telemetry
- **Version-aware pricing** — token costs reflect Anthropic's pricing tiers per model

## Coding Conventions

- ES module imports (`import`/`export`)
- No build tooling or transpilation
- Inline styles and scripts in dashboard.html (no external CSS/JS bundles)
- Express 5 (path params, async error handling)
- Functions and variables use camelCase
- Constants defined at module top

## Available Skills

Use these skills when working on this project:

- **`/simplify`** — Review changed code for reuse, quality, and efficiency, then fix issues found. Use after writing or modifying code.
- **`/frontend-design`** — Create distinctive, production-grade frontend interfaces. Use when modifying `dashboard.html` or building new UI components.
- **`/claude-developer-platform`** — Build apps with the Claude API or Anthropic SDK. Use when working on agent integrations in `src/agents/`.
- **`/find-skills`** — Discover and install new agent skills for extended capabilities.
- **`/keybindings-help`** — Configure keyboard shortcuts for Claude Code.

## Important Notes

- The dashboard is a single 3000+ line HTML file — changes should maintain the inline architecture
- Cache is stored at `~/.cache/agent-analytics/parsed-sessions.json`
- Session JSONL files are at `~/.claude/projects/`
- Token pricing is hardcoded in `claude-parser.js` — update when Anthropic changes pricing
- Playwright tests require Claude session fixtures to run (run locally, not in CI)
- CI runs syntax checks only; E2E tests are local-only
