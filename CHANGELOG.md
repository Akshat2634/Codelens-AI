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
