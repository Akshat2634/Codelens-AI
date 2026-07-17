# CLAUDE.md — Codelens-AI

## Project Overview

**Codelens AI** (`codelens-ai` on npm) is a CLI tool that measures ROI from AI coding agents by correlating token usage with git commit output. It parses **Claude Code** session files (`~/.claude/projects/`) and **OpenAI Codex CLI** rollout files (`~/.codex/sessions/`), analyzes git history, and serves an interactive dashboard at `http://localhost:3457` with per-agent source tabs (All Agents / Claude Code / OpenAI Codex).

**Version:** 0.9.0
**License:** MIT
**npm package:** `codelens-ai` (alias: `claude-roi`)

## Tech Stack

- **Runtime:** Node.js >= 22.12, ES modules (`"type": "module"`)
- **Backend:** Express.js 5.0.0
- **CLI:** Commander.js 13.0.0
- **MCP:** `@modelcontextprotocol/sdk` — `codelens-ai mcp` serves the reports as MCP tools over stdio (`src/mcp.js`); stdout carries only JSON-RPC, so all progress output must go to stderr there
- **Frontend:** Single-file HTML (`src/dashboard.html`) with vanilla JS + Chart.js 4.5.1. The UMD bundle is **committed at `src/vendor/chart.umd.min.js`** and served at `/vendor/chart.umd.min.js` — no CDN, works offline, and does not depend on `chart.js` being resolvable at the user's runtime (npx caches have shipped partial `node_modules`). `chart.js` is a **devDependency**; refresh the vendored copy with `npm run vendor:chart` after upgrading it (also runs on `prepublishOnly`).
- **Testing:** `node --test` unit + server-route tests (`tests/unit/`), a packaging smoke test (`npm run test:package` — packs → clean-installs → boots → asserts the dashboard and vendored chart serve), and Playwright (E2E)
- **Styling:** Inline CSS design tokens, "warm-ink instrument panel" (dark) / "warm-paper ledger" (light) theme; fonts: Bricolage Grotesque (display), Instrument Sans (body), IBM Plex Mono (data). Chart palette is CVD-validated per theme — don't swap chart hues casually.

## Project Structure

```
src/
├── index.js           # CLI entry point & orchestration (Commander)
├── banner.js          # Pixel-block "CODELENS AI" startup splash (interactive TTY dashboard runs only)
├── claude-parser.js   # Parses JSONL session files from ~/.claude/projects/
├── codex-parser.js    # Parses OpenAI Codex rollout files from ~/.codex/sessions/
├── git-analyzer.js    # Git log analysis, branch detection, diff stats
├── correlator.js      # Matches sessions to commits via file overlap + time window + Co-authored-by trailers
├── metrics.js         # ROI calculations, grades, insights, heatmap, survival rate, AI code share, value leak
├── report.js          # `codelens-ai report` — terminal / Markdown / HTML ROI scorecard
├── tables.js          # `codelens-ai daily|weekly|monthly` — usage/cost tables + ROI columns
├── blocks.js          # `codelens-ai blocks` — 5-hour billing windows, burn rate, projection
├── statusline.js      # `codelens-ai statusline` — Claude Code statusline (stdin JSON + quickstats: ROI, burn rate)
├── mcp.js             # `codelens-ai mcp` — MCP server over stdio (roi_summary, usage, blocks, sessions, projects, refresh tools)
├── server.js          # Express REST API routes (?source= selects per-agent views)
├── cache.js           # Smart caching with per-source stale file detection + statusline quickstats
├── pricing.js         # External LiteLLM pricing overlay — auto-prices models the hardcoded tables don't know
└── dashboard.html     # Single-file SPA dashboard (4000+ lines)

tests/
├── unit/              # node --test suites (parsers, correlator, metrics, server)
├── e2e/smoke.spec.js  # Playwright smoke suite (fixture-backed, incl. source tabs)
├── fixtures/          # build-fixtures.js generates Claude + Codex session fixtures
└── local/             # full dashboard suite for local runs

.github/workflows/
├── ci.yml             # CI: syntax check, unit tests, CLI smoke (both agents), Node 22/24 matrix
├── codeql.yml         # CodeQL code scanning (javascript-typescript + actions), weekly + per-PR
└── release.yml        # npm publish on version tag push
```

## Data Flow

```
Claude Sessions (JSONL)  → claude-parser.js ┐
Codex Rollouts (JSONL)   → codex-parser.js  ┴→ [Cache] → git-analyzer.js
→ correlator.js (all sources together) → metrics.js (per-source payloads)
→ server.js (REST API, ?source=) → dashboard.html (source tabs)
```

Every session object carries `source: 'claude' | 'codex'` and an identical shape (codex-parser mirrors claude-parser's output). Correlation runs over ALL sessions together so a commit is claimed by at most one session across agents; per-source payloads filter the correlated set.

## Key API Routes (server.js)

All GET routes accept `?source=all|claude|codex` (default `all`; per-agent views exist only when both agents have sessions — unknown source falls back to `all`).

- `GET /` — dashboard HTML
- `GET /api/all` — full payload
- `GET /api/summary` — hero stats + insights
- `GET /api/timeline` — daily cost/output chart data
- `GET /api/sessions` — paginated sessions with sorting
- `GET /api/models` — model breakdown
- `GET /api/heatmap` — productivity heatmap
- `GET /api/projects` — per-repository ROI (cost, commits, $/commit, lines, main %); drives the dashboard's Projects section. Grouped by the repo's `origin` remote (via `git-analyzer.getRepoRemote`) so clones / worktrees / moved checkouts of one repo collapse into a single entry; repos with no remote fall back to path, and same-named distinct repos get an `owner/repo` label
- `GET /api/tools` — tool usage breakdown
- `GET /api/skills` — Skill invocations, by skill name
- `GET /api/mcp-servers` — MCP server usage, grouped from `mcp__<server>__<tool>` calls
- `GET /api/clients` — sessions by client surface (`entrypoint`: cli, claude-vscode, codex-cli, ...)
- `GET /api/agent-type` — sessions by agent type (main_only vs delegated to a subagent)
- `GET /api/feature-adoption` — share of sessions using Sub-agents / Skills / MCP / Plan mode
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
npx codelens-ai --source codex  # analyze a single agent: claude | codex
npx codelens-ai --offline       # skip network pricing refresh (cached/hardcoded rates only)
npx codelens-ai --claude-dir X  # override ~/.claude/projects (testing/CI)
npx codelens-ai --codex-dir X   # override ~/.codex/sessions (testing/CI)
npx codelens-ai --plan max20 --codex-plan plus   # per-agent subscription mode
npx codelens-ai --host 0.0.0.0  # expose dashboard beyond localhost (default 127.0.0.1)
npx codelens-ai report          # terminal ROI scorecard (--md / --html to export)
npx codelens-ai daily           # usage/cost table by day (+ commits, $/commit); -b per-model, --json
npx codelens-ai weekly          # ...by week (--start-of-week monday|sunday); `monthly` = by month
npx codelens-ai blocks          # Claude's 5-hour billing windows + burn rate (--active, --recent, -t max)
npx codelens-ai mcp             # MCP server over stdio (claude mcp add codelens -- npx -y codelens-ai mcp)
npx codelens-ai statusline      # Claude Code statusline (--install to configure)
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
- **Zero-config** — auto-discovers `~/.claude/projects/` and `~/.codex/sessions/` (`$CODEX_HOME` honored)
- **Smart caching** — incremental parsing with per-source staleness, so a new Codex rollout doesn't force a Claude re-parse (`~/.cache/agent-analytics/`)
- **File-first correlation** — sessions matched to commits by file overlap, 2-hour temporal buffer; all agent sources correlate together so a commit is attributed to at most one session. `Co-authored-by` agent trailers (parsed from git log) route trailer-stamped commits to the matching agent and upgrade attribution confidence to high
- **Uniform session shape** — codex-parser produces the exact claude-parser session shape (`cacheReadTokens` = OpenAI `cached_input_tokens`, `cacheCreationTokens` = 0) so correlator/metrics/server are source-agnostic
- **Privacy-first** — all data stays local, no telemetry; the dashboard binds 127.0.0.1 by default (`--host` to override)
- **Version-aware pricing** — token costs reflect each provider's pricing tiers per model (Anthropic per-version tiers; OpenAI per-model-id, with o3's Jun 2025 price cut date-tiered)
- **Auto-pricing fallback** — models the hardcoded tables don't match are priced from LiteLLM's public map (`src/pricing.js`): fetched on demand, disk-cached ~24h (`pricing.json`), refreshed on `--refresh`, skipped with `--offline`, and graceful on failure (cache → hardcoded Sonnet/`CODEX_FALLBACK` estimate). **Hardcoded tables win** when both have a model; overlay-priced models are real rates, so NOT flagged estimated. The overlay must be loaded (`loadPricingOverlay`, awaited in `buildPayload`) before any costing; `lookupExternalRate` is a no-op until then
- **Update nudge** (`src/update-check.js`) — every run checks npm's registry for a newer published version and prints an upgrade hint if behind; disk-cached ~24h (`version-check.json`), capped at 400ms so a slow network never delays a real command, skipped with `--offline`, silent on any failure. Exists because `npx codelens-ai` (no version pin) can silently run a stale global install or npx-cached copy — old enough to predate whole subcommands — producing a confusing Commander parse error instead of a hint to upgrade (see README Troubleshooting)
- **Nested-repo discovery** — when a session's cwd is a workspace parent with no `.git` of its own, `git-analyzer.js#findNestedGitRepos` walks up to `NESTED_REPO_DEPTH` (3) levels to find sub-repos, and `index.js#explodeWorkspaceSessions` splits the session into one virtual clone per touched sub-repo so their commits correlate. Always on, zero-config, no flag — the gate (`session.repoPath` has no `.git`) never fires for an ordinary single-repo session, so it's a no-op for the common case. Only the sub-repo with the most touched files keeps the session's real cost/tokens (`costZeroed: true` on the rest) — total spend is conserved, but a zeroed clone must never be graded (`computeSessionGrade` returns `null` for it) since a real commit landing on a `$0` clone would otherwise look like a fabricated 'A'

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

- The dashboard is a single 4000+ line HTML file — changes should maintain the inline architecture
- Cache is stored at `~/.cache/agent-analytics/parsed-sessions.json` (plus `quickstats.json`, a tiny summary the statusline reads); runs with custom `--claude-dir`/`--codex-dir` write to a separate `parsed-sessions-<hash>.json` so tests/CI never evict the real cache
- Claude session JSONL files are at `~/.claude/projects/`; Codex rollouts at `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (zstd-compressed `.jsonl.zst` after ~7 days — readable on Node >= 22.15)
- Token pricing is hardcoded in `claude-parser.js` (Anthropic) and `codex-parser.js` (OpenAI) — update when providers change pricing
- Codex gotchas already handled in `codex-parser.js`: `token_count` totals are cumulative (use `last_token_usage` deltas), duplicate re-logged usage events (deduped only when the cumulative total is unchanged), `cached_input_tokens ⊂ input_tokens`, `reasoning_output_tokens ⊂ output_tokens`, subagent `thread_spawn` rollouts replay parent history (skipped), legacy pre-envelope 2025 format, long-context pricing only above 272K input tokens per request
- Playwright tests require session fixtures to run (regenerated by `tests/fixtures/build-fixtures.js`)
- CI runs syntax checks, unit tests, and a fixture-backed CLI smoke run for both agents; Playwright E2E tests are local-only
