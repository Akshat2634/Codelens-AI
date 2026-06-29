# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.9.0] - 2026-06-29

A competitive-review-driven overhaul: lead with cost and durability of code that survived,
counterbalance every activity number with a quality number, and stay fully local.

### Added

- **Billing-aware costs** — `--plan api|pro|max5x|max20x|free` and an in-dashboard toggle that reframe dollar figures for subscription users (flat fee + API-equivalent value) instead of always assuming pay-per-token rates.
- **Active-time engine** — gap-capped focus minutes from per-message timestamps (vs idle-inflated wall-clock); cost per active hour.
- **Cost Control panel** — cache-hit gauge + estimated savings, premium-model (Opus) spend share with a Sonnet-rebalance estimate, and subagent (delegated) spend.
- **Outcome / quality metrics** — revert rate, AI bug-fix-follow-on (rework) rate, deletion ratio, and unmatched-AI-commit detection, with published benchmark bands.
- **Durability** — per-language survival rollup; opt-in true git-blame line survival + **code half-life** decay curve (`--blame`).
- **Match confidence** — correlation scores each match (high/medium/low) and cross-validates against `Co-authored-by` / committer-email AI-authorship; lockfiles/generated/minified files excluded from line attribution.
- **Waste & burn** — high cost-per-active-minute sessions and test-retry over-iteration loops.
- **Coding streaks**, **weekly digest HTML** (`--digest`), and an embeddable survival-led **ROI badge** (`--badge`) — all on-disk, no daemon/SMTP.
- New documented API routes: `/api/cost-control`, `/api/quality`, `/api/waste`, `/api/streaks`, `/api/half-life`; `/api/all?days=&project=` re-windowing.

### Changed

- Dashboard restructured into **Diagnostic** (how the work was done) vs **Outcome** (whether it stuck).
- Single survival-weighted ROI grade (60% durability / 40% cost) — consolidated the previous two grading scales.
- Per-model breakdown now uses real primary-model attribution instead of fabricated fractional commit counts.
- Chart.js is bundled locally and web fonts replaced with system stacks — the dashboard works fully offline (no CDN), honoring the privacy-first promise.

### Removed

- Token "fun facts" (novels-worth-of-text), the fabricated hour-axis on the cost heatmap, and the meaningless fixed-denominator "toolbelt coverage" metric.

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
