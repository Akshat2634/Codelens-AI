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

- **Squash-merge / branch-copy commits were double-counted (Claude & all sources)** — `git-analyzer` deduped only exact rebase/cherry-pick copies (keyed on the byte-for-byte `%aI` author date), so GitHub "Squash and merge" twins (a new commit on the default branch with a drifted author date and a `(#NNNN)` subject suffix) survived under `git log --all` and both were counted. A second, conservative dedup pass now collapses an off-branch twin into its on-default-branch copy only when the author, the full per-file diffstat, and the normalized subject all match and the author dates fall within 10 minutes — inflated commit/line totals and deflated cost-per-commit are corrected (verified on real data: techops 228 → 171 commits, avg cost/commit $6.89 → $9.18, ~25% fewer phantom commits)
- **`filesWritten` now records `MultiEdit` and `NotebookEdit`** — only `Write`/`Edit` were tracked, so a Claude session editing files solely through those tools had empty `filesWritten` and fell back to weaker time-only commit attribution or was orphaned
- **System-injected `isMeta` messages no longer inflate `userMessageCount`** — skill notices, slash-command definitions, and image placeholders (~7–12% of counted user messages in real data) were counted as genuine user turns, skewing the autopilot ratio, the chat-only attribution floor, and the orphaned-session threshold
- **Per-family tokens-per-commit** now divides dominant-session tokens by dominant-session commits (the same population as cost-per-commit), instead of dividing family-wide tokens by dominant-only commits — which made background-helper models (e.g. Haiku, dominant for few commits) look grossly inefficient on `/api/models` and in the token-efficiency insight
- **Self-heal insight and Agent Autonomy card now show a consistent fraction** — the score (verification ÷ state-changing shell calls, read-only excluded) was printed next to the *full* bash count, so "6% of 9,700 commands" implied ~2.4× more verification commands than existed; both now display the state-changing denominator
- **`modelBaseId` strips Anthropic's contiguous `-YYYYMMDD` snapshot suffix** (previously only OpenAI's dashed `-YYYY-MM-DD`), so a dated and undated snapshot of one Claude model collapse to a single entry — no phantom "+ Model" duplicate in the sessions table and the family donut/cost-per-commit label resolves to the real model name instead of the generic family
- **Sessions-table Model column no longer labels extra models "(sub)"** — additional models in a Claude session can be mid-session `/model` switches *or* subagents; the tag and tooltip asserted "subagents spawned for background tasks", mislabeling direct in-transcript switches. The tag is dropped (the leading "+ " already marks them additional) and the tooltip wording is neutral
- **Orphaned-session insight wording** corrected from "ran 10+ messages" to "ran more than 10 messages" to match the `> 10` threshold
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
