# CLAUDE.md — Codelens-AI

## Project Overview

**Codelens AI** (`codelens-ai` on npm) is a CLI tool that measures ROI from AI coding agents by correlating Claude Code token usage with git commit output. It parses Claude Code session files, analyzes git history, and serves an interactive dashboard at `http://localhost:3457`.

**Version:** 0.8.2
**License:** MIT
**npm package:** `codelens-ai` (alias: `claude-roi`)

## Tech Stack

- **Runtime:** Node.js >= 18, ES modules (`"type": "module"`)
- **Backend:** Express.js 5.0.0
- **CLI:** Commander.js 13.0.0
- **Frontend:** Single-file HTML (`src/dashboard.html`) with vanilla JS + Chart.js 4.4.7
- **Testing:** Playwright (E2E)
- **Styling:** Inline CSS with CSS variables, glassmorphism design, dark/light theme

## Project Structure

```
src/
├── index.js           # CLI entry point & orchestration (Commander)
├── claude-parser.js   # Parses JSONL session files from ~/.claude/projects/
├── git-analyzer.js    # Git log analysis, branch detection, diff stats
├── correlator.js      # Matches sessions to commits via file overlap + time window
├── metrics.js         # ROI calculations, grades, insights, heatmap, survival rate
├── server.js          # Express REST API routes
├── cache.js           # Smart caching with stale file detection
├── dashboard.html     # Single-file SPA dashboard (3000+ lines)
└── agents/            # Agent integration stubs (claude/, cursor/)

tests/
└── dashboard.spec.js  # Playwright E2E tests

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
- `GET /api/all` — full payload
- `GET /api/summary` — hero stats + insights
- `GET /api/timeline` — daily cost/output chart data
- `GET /api/sessions` — paginated sessions with sorting
- `GET /api/models` — model breakdown
- `GET /api/heatmap` — productivity heatmap
- `GET /api/tools` — tool usage breakdown
- `GET /api/survival` — line survival stats
- `GET /api/tokens` — detailed token analytics
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
