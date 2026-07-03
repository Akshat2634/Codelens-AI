# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **OpenAI Codex CLI support** — end-to-end: `src/codex-parser.js` parses `~/.codex/sessions/` rollout files (envelope format, legacy 2025 pre-envelope format, and zstd-compressed `.jsonl.zst` archives on Node >= 22.15) into the same session shape as the Claude parser
- **Agent source tabs** — when both Claude Code and Codex sessions exist, the dashboard shows All Agents / Claude Code / OpenAI Codex tabs; every section recomputes per agent, and the selection persists across reloads
- `?source=all|claude|codex` on all API routes; per-source payloads computed server-side
- OpenAI model pricing (GPT-5.x, GPT-5.x-Codex, codex-mini, o3/o4-mini with o3's Jun 2025 price cut date-tiered); unpriced models are costed at proxy rates and flagged as estimated spend
- CLI flags: `--source claude|codex`, `--codex-dir`, `--codex-plan free|go|plus|pro100|pro|business|business-annual`, `--codex-plan-cost`
- Codex accounting correctness: per-request `last_token_usage` deltas (cumulative-total fallback with reset handling), exact-duplicate event dedup, subagent `thread_spawn` replay-burst skip, `cached_input ⊂ input` and `reasoning ⊂ output` semantics, plus OpenAI web-search server-tool fees
- Per-source cache staleness — a new Codex rollout no longer forces a Claude re-parse (cache schema v13)

### Fixed

- Codex duplicate `token_count` events were not actually deduplicated: the dedup key included the event's timestamp, but real duplicate re-logs (Codex re-announcing the same completed turn's usage seconds-to-minutes later) carry different timestamps, so the key never matched and usage was double- or quadruple-counted on affected sessions
- **Long-context pricing threshold corrected from 200K to >272K input tokens** — OpenAI's GPT-5.5/5.4 long-context tier applies only to requests exceeding the 272K standard input cap, so 200K–272K requests were overbilled at 2x input / 1.5x output rates (and cache savings correspondingly inflated)
- Token dedup now also requires the cumulative total to be unchanged, so a genuine repeat request with an identical per-turn delta can never be dropped; all-zero compaction events no longer inflate `assistantMessageCount`
- `filesWritten` no longer collapses to bare basenames when a rollout's recorded cwd is a stale alias of the repo root (e.g. the repo moved from `GitHub/` to `GitHub.nosync/`) — paths now recover via folder-name suffix matching, restoring commit line attribution
- Chat-only sessions need at least 5 messages before they can claim commits by time proximity alone (a 6-second one-prompt session could previously absorb whole manual commits)
- Attribution confidence no longer forces "low" on commits landing after the session window: strong file overlap now reads high/medium — Codex commits (which always land post-session since Codex CLI never commits for you) were 100% "low" by construction
- `--json` no longer truncates at the 64KB pipe buffer (`codelens-ai --json | jq` lost ~97% of the payload), no longer mixes the colored progress banner into stdout (goes to stderr), and emits valid JSON (`null`) with zero sessions
- Toolbelt coverage and self-heal score are now measured against each agent's own tool vocabulary — Codex was scored against Claude's 14-tool list (structurally "Narrow tool usage") and its shell-routed file reads (62% of calls) deflated self-heal to 5%
- Per-agent attribution panels no longer label the other agent's AI-matched commits as "Organic (manual)"
- Sparse timelines are gap-filled with zero days so months-apart bursts no longer render as a smooth interpolated trend; axis labels include the year on multi-year ranges
- Deep-research models (`o3-deep-research`, `o4-mini-deep-research`) get explicit pricing instead of silently binding to their cheaper prefix siblings
- `--source all` accepted as the documented no-filter value; `?source=` deep links honored on dashboard load; `--days`/`--port` validated up front; nonexistent `--claude-dir`/`--codex-dir` warned about; `CODEX_HOME` overrides no longer evict the primary cache; moved-repo aliasing corroborates against `git ls-files` before claiming commits; ChatGPT `team` plan recognized
- Model display polish: null-model sessions sort deterministically, legacy `claude-3-5-sonnet-*` ids render as "Sonnet 3.5" (not "3"), long-context billing buckets are no longer listed as separate models, `[1m]` marker supported, misleading tooltips corrected (self-heal, toolbelt, cost-per-commit chart, Lines column, estimated-cost banner, cache-write funnel hidden for Codex)
- Sessions whose repo was later moved or renamed on disk (e.g. a folder reorganization) permanently showed zero correlated commits — `analyzeGitRepo` did a literal path-existence check with no fallback. Moved repos are now auto-resolved by matching folder name against another still-valid path from the same parse run; ambiguous or unmatched paths are surfaced with a warning instead of silently returning empty

## [0.2.1] - 2026-02-26

### Fixed

- Corrected inflated lines-added count and model breakdown attribution
- Excluded subagent messages from session message counts
- Deduplicated continuation sessions

## [0.2.0] - 2026-02-26

### Added

- Token Usage Analytics dashboard section with funnel visualization
- Cost Breakdown section with per-period token counts
- Comprehensive Playwright test suite (165+ tests)
- Session caching for near-instant subsequent startups

### Fixed

- Log scale for per-commit comparison bars
- Unified legend UI across all sections
- Tooltip clipping in stat cards
- Excluded lock files and generated files from line-count metrics

### Changed

- Redesigned top 3 dashboard sections with distinct modern layouts

## [0.1.1] - 2026-02-25

### Fixed

- Derived project name from repo path correctly

## [0.1.0] - 2026-02-25

### Added

- Initial release
- CLI with `--days`, `--port`, `--json`, `--project`, `--refresh`, `--no-open` flags
- Claude Code JSONL session parser with model-aware cost calculation
- Git log analyzer with branch awareness and default branch detection
- Session-to-commit correlation (file-based primary, time-based fallback)
- ROI metrics: cost per commit, line survival, orphaned sessions, ROI grade
- Interactive dashboard with hero stats, timeline, heatmap, model comparison
- Incremental caching layer
