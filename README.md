# Codelens AI

**[codelensai-dev.vercel.app](https://codelensai-dev.vercel.app/)**

**Agent Productivity-to-Cost Correlator** — Is your AI coding agent actually shipping code?

Codelens AI ties Claude Code token usage to actual git output. It reads your local Claude Code session files, correlates them with git commits by timestamp, and serves a dashboard answering: *"Am I getting ROI from my AI coding agent?"*

- One command, zero config
- All data stays local
- Works with any git repo where you've used Claude Code

## Installation

> **Previously published as `claude-roi`.** That package is deprecated — use `npx codelens-ai` going forward. The `claude-roi` command still works as a backward-compatible alias.

### Option 1: Run directly (no install)

```bash
npx codelens-ai
```

### Option 2: Install globally

```bash
# npm
npm install -g codelens-ai

# pnpm
pnpm add -g codelens-ai

# yarn
yarn global add codelens-ai
```

Then run anywhere:

```bash
codelens-ai
```

### Option 3: Clone and run from source

```bash
git clone https://github.com/Akshat2634/Codelens-AI.git
cd Codelens-AI

# Install dependencies (pick one)
npm install
# or
pnpm install
# or
yarn install

# Run it
node src/index.js
```

## Prerequisites

- **Node.js >= 18** — [Download](https://nodejs.org/)
- **Git** — installed and configured with `user.name` and `user.email`
- **Claude Code** — you must have used [Claude Code](https://claude.com/claude-code) at least once so session data exists at `~/.claude/projects/`

## Quick Start

```bash
npx codelens-ai
```

This parses your `~/.claude/projects/` session data, analyzes your git repos, and opens a dashboard at `http://localhost:3457`.

## What It Measures

Codelens frames metrics as **Diagnostic** (how the work was done) and **Outcome** (whether it stuck) — every activity number is counterbalanced by a quality number.

| Metric                     | Description                                                                  |
| -------------------------- | ---------------------------------------------------------------------------- |
| **Cost per Commit / Line** | How much each AI-assisted commit (and surviving line) costs                  |
| **Line Survival Rate**     | % of AI-written lines that survive 24h without being rewritten               |
| **Code Half-Life** (`--blame`) | True git-blame durability: how long AI lines stay attributed to their commit |
| **Rework Rate**            | % of AI commits followed by a same-file bug-fix within a week (DORA-style)    |
| **Revert Rate**            | % of commits that were reverts                                               |
| **ROI Grade (A-F)**        | Single survival-weighted score (60% durability, 40% cost efficiency)         |
| **Cache Hit Rate**         | % of input served from cache + estimated savings (a top cost lever)          |
| **Model Routing**          | Premium (Opus) spend share + estimated Sonnet-rebalance savings              |
| **Active Time**            | Gap-capped focus minutes (not idle wall-clock) → cost per active hour        |
| **Per-Language Durability**| Survival rate broken down by language                                        |
| **Waste & Burn**           | High spend-rate sessions with no output, and test-retry loops                |
| **Coding Streak**          | Consecutive days with AI-assisted committed output                           |
| **Autonomy Score**         | Composite A-F: autopilot ratio, self-heal score, commit velocity             |
| **Billing-aware cost**     | Reframe dollars for API / Pro / Max / tokens-only billing (`--plan`)         |

## CLI Options

```bash
codelens-ai                        # default: last 30 days, port 3457
codelens-ai --days 90              # look back 90 days
codelens-ai --port 8080            # custom port
codelens-ai --no-open              # don't auto-open browser
codelens-ai --json                 # dump all metrics as JSON to stdout
codelens-ai --project techops      # filter to a specific project
codelens-ai --refresh              # force full re-parse (ignore cache)
codelens-ai --plan pro             # reframe cost for your billing: api|pro|max5x|max20x|free
codelens-ai --blame                # compute true git-blame line survival + code half-life (slower)
codelens-ai --digest report.html   # write a self-contained weekly digest HTML and exit
codelens-ai --badge .              # write an embeddable ROI badge (SVG + Markdown) and exit
codelens-ai --autonomy             # print autonomy score to terminal and exit
```

> **Billing-aware costs:** dollar figures default to API pay-per-token rates. If you're on a
> Claude.ai Pro/Max subscription, pass `--plan pro` (or `max5x`/`max20x`) — Codelens reframes
> spend as your flat monthly fee while still showing the API-equivalent value of your tokens.

## Dashboard

The dashboard is split into **Diagnostic** (how the work was done) and **Outcome** (whether it stuck):

- **Billing toggle + filters** — switch billing model and re-scope lookback/project without restarting
- **Hero stats** — plan-aware spend, commits shipped, cost per commit, survival-weighted ROI grade
- **Cost Control** — cache-hit gauge + savings, premium-model routing with rebalance estimate, subagent spend
- **Smart insights** — auto-generated, prioritized observations (cache, routing, rework, orphans…)
- **Cost vs Output timeline** + **token burn rate** — daily cost and lines added
- **Model comparison** — real per-model cost/commit (primary-model attribution) and spend share
- **Productivity heatmap** — GitHub-style grid showing when you're most productive
- **Agent Autonomy** — autonomy score, autopilot ratio, self-heal score, commit velocity, top verification commands
- **Outcome panels** — line survival, rework/revert rates with benchmark bands, per-language durability, AI code half-life (`--blame`), coding streak, and waste/burn
- **Sessions table** — sortable, expandable table with per-session metrics, match confidence, and matched commits

Charts render from a **locally vendored Chart.js** (no CDN) so the dashboard works fully offline.

## How It Works

1. **Parses** JSONL session files from `~/.claude/projects/`
2. **Analyzes** git history from each repo you've worked in with Claude
3. **Correlates** sessions to commits by file overlap, with a 2-hour temporal buffer as fallback; each match carries a confidence score and cross-validates against AI-authorship (`Co-authored-by`) trailers
4. **Calculates** cost using Anthropic token pricing (input, output, cache read/write)
5. **Serves** an interactive dashboard on localhost

### Caching

Parsed session data is cached at `~/.cache/agent-analytics/parsed-sessions.json`. On subsequent runs, only new or modified JSONL files are re-parsed, making startup near-instant. Use `--refresh` to force a full re-parse.

### Cost Calculation

Token costs are version-aware and calculated per model (see [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing)):

| Model | Input | Output | Cache Read | Cache Write |
| --- | --- | --- | --- | --- |
| Opus 4.8 | $5/M | $25/M | $0.50/M | $6.25/M |
| Opus 4.7 | $5/M | $25/M | $0.50/M | $6.25/M |
| Opus 4.6 | $5/M | $25/M | $0.50/M | $6.25/M |
| Opus 4.5 | $5/M | $25/M | $0.50/M | $6.25/M |
| Opus 4.0/4.1 (legacy) | $15/M | $75/M | $1.50/M | $18.75/M |
| Sonnet 3.7/4.0/4.5/4.6 | $3/M | $15/M | $0.30/M | $3.75/M |
| Haiku 4.5 | $1/M | $5/M | $0.10/M | $1.25/M |
| Haiku 3.5 | $0.80/M | $4/M | $0.08/M | $1.00/M |
| Haiku 3 | $0.25/M | $1.25/M | $0.03/M | $0.30/M |

### Line Survival

By default, line survival uses an approximate heuristic: if lines added in commit A are deleted by a subsequent commit on the same file within 24 hours, they're counted as "churned." Survival rates are rounded to the nearest 5%, and generated/lock/minified files are excluded from attribution.

For **true durability**, run with `--blame`: Codelens runs `git blame` at HEAD across files touched by AI-correlated commits and counts how many lines are *still attributed* to their original AI commit (any later edit counts as not surviving). It reports an aggregate survival %, a weekly decay curve, and an estimated **code half-life** (gated behind sufficient history). This is slower and opt-in.

## Project Structure

```text
Codelens-AI/
├── package.json
├── README.md
├── .gitignore
└── src/
    ├── index.js          # CLI entry point
    ├── claude-parser.js  # Parse Claude Code JSONL session files
    ├── cache.js          # Parsed data caching layer
    ├── git-analyzer.js   # Parse git log with branch awareness
    ├── correlator.js     # Match sessions to commits by timestamp
    ├── metrics.js        # Calculate ROI metrics and insights
    ├── artifacts.js      # Weekly digest HTML + embeddable ROI badge generators
    ├── server.js         # Express server + API routes
    ├── dashboard.html    # Single-file dashboard (inline CSS/JS)
    └── vendor/           # Locally bundled Chart.js (no CDN)
```

## Releasing

Releases are automated via GitHub Actions. To publish a new version:

```bash
npm version patch   # or minor / major
git push --follow-tags
```

This automatically publishes to npm and creates a GitHub Release with auto-generated notes.

**Setup (one-time):** Configure [trusted publishing](https://docs.npmjs.com/trusted-publishers/) on npm for the `codelens-ai` package, linking it to the GitHub Actions workflow. No tokens or secrets needed.

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, guidelines, and ideas for contributions.

## Privacy

All data stays on your machine. The only network requests are for Chart.js and Inter font from CDNs. No telemetry, no data collection.

## License

MIT
