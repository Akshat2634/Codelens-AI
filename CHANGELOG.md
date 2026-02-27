# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
