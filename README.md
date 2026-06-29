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

| Metric                | Description                                                     |
| --------------------- | --------------------------------------------------------------- |
| **Cost per Commit**   | How much each AI-assisted commit costs in tokens                |
| **Line Survival Rate**| % of AI-written lines that survive 24h without being rewritten  |
| **Orphaned Sessions** | Sessions with 10+ messages that produced zero commits           |
| **ROI Grade (A-F)**   | Composite score based on tokens-per-commit and survival rate    |
| **Model Comparison**  | Efficiency breakdown across Opus, Sonnet, and Haiku             |
| **Branch Awareness**  | What % of AI commits landed on production                       |
| **Peak Hours**        | Hour-of-day x day-of-week productivity heatmap                  |
| **Autonomy Score**    | Composite A-F grade measuring how independently the agent works |
| **Autopilot Ratio**   | Assistant messages per user prompt (higher = more autonomous)   |
| **Self-Heal Score**   | % of bash calls that are test/lint commands (self-verification) |
| **Toolbelt Coverage** | % of available tools used per session (workflow breadth)        |
| **Commit Velocity**   | Tool calls per commit (lower = more efficient)                  |

## CLI Options

```bash
codelens-ai                        # default: last 30 days, port 3457
codelens-ai --days 90              # look back 90 days
codelens-ai --port 8080            # custom port
codelens-ai --no-open              # don't auto-open browser
codelens-ai --json                 # dump all metrics as JSON to stdout
codelens-ai --project techops      # filter to a specific project
codelens-ai --refresh              # force full re-parse (ignore cache)
codelens-ai --autonomy             # print autonomy score to terminal and exit
codelens-ai --plan max20           # subscription mode: effective $/commit vs your flat plan
codelens-ai --plan-cost 150        # custom monthly subscription cost (USD)
```

### Effective cost (subscription mode)

By default costs are **API-equivalent** — what your usage *would* cost at pay-as-you-go token rates. If you're on a flat-rate Claude plan, those dollars aren't what you actually pay. Pass `--plan` (`pro` = $20/mo, `max5` = $100/mo, `max20` = $200/mo) or `--plan-cost <usd>` to add an **Effective Cost** panel that prorates your subscription to the analyzed window and shows:

- **Effective $/commit** and **$/surviving line** — your prorated fee ÷ output, the cost figures that actually reflect your bill.
- **Plan utilization** — API-equivalent value ÷ prorated fee (e.g. `3.2×` means you extracted ~3.2× your subscription in pay-as-you-go value). This is an estimate of value extracted, **not** realized savings.

## Dashboard

The dashboard includes:

- **Hero stats** — total cost, commits shipped, cost per commit, ROI grade
- **Attribution & Coverage** — per-commit confidence (high/medium/low) that a commit was really the AI's, plus a reconciliation of AI-attributed vs co-authored vs organic (manual) lines, so the ROI numbers are auditable rather than a black box
- **Smart insights** — auto-generated observations about your usage patterns
- **Cost vs Output timeline** — dual-axis chart of daily cost and lines added
- **Model comparison** — cost breakdown by Claude model
- **Session length analysis** — which session sizes have the best ROI
- **Productivity heatmap** — GitHub-style grid showing when you're most productive
- **Agent Autonomy** — autonomy score badge, autopilot ratio, self-heal score, toolbelt coverage, commit velocity, and top verification commands
- **Sessions table** — sortable, expandable table with per-session metrics, matched commits, and autopilot ratio

## How It Works

1. **Parses** JSONL session files from `~/.claude/projects/`
2. **Analyzes** git history from each repo you've worked in with Claude
3. **Correlates** sessions to commits by timestamp (during session + 30min buffer)
4. **Calculates** cost using Anthropic token pricing (input, output, cache read/write)
5. **Serves** an interactive dashboard on localhost

### Caching

Parsed session data is cached at `~/.cache/agent-analytics/parsed-sessions.json`. On subsequent runs, only new or modified JSONL files are re-parsed, making startup near-instant. Use `--refresh` to force a full re-parse.

### Cost Calculation

Token costs are version-aware and calculated per model, accounting for the two prompt-cache write rates. Multipliers (relative to base input): **cache read = 0.1×**, **5-minute cache write = 1.25×**, **1-hour cache write = 2×**. Figures below are verified against [Anthropic's pricing](https://platform.claude.com/docs/en/about-claude/pricing) (per million tokens):

| Model | Input | Output | Cache Read | Cache Write (5m) | Cache Write (1h) |
| --- | --- | --- | --- | --- | --- |
| Fable 5 / Mythos 5 | $10/M | $50/M | $1.00/M | $12.50/M | $20/M |
| Opus 4.8 | $5/M | $25/M | $0.50/M | $6.25/M | $10/M |
| Opus 4.7 | $5/M | $25/M | $0.50/M | $6.25/M | $10/M |
| Opus 4.6 | $5/M | $25/M | $0.50/M | $6.25/M | $10/M |
| Opus 4.5 | $5/M | $25/M | $0.50/M | $6.25/M | $10/M |
| Opus 4.0/4.1 (legacy) | $15/M | $75/M | $1.50/M | $18.75/M | $30/M |
| Sonnet 3.7/4.0/4.5/4.6 | $3/M | $15/M | $0.30/M | $3.75/M | $6/M |
| Haiku 4.5 | $1/M | $5/M | $0.10/M | $1.25/M | $2/M |
| Haiku 3.5 | $0.80/M | $4/M | $0.08/M | $1.00/M | $1.60/M |
| Haiku 3 | $0.25/M | $1.25/M | $0.03/M | $0.30/M | $0.50/M |

> **Note — Claude Fable 5 / Mythos 5:** Anthropic [suspended access](https://www.anthropic.com/news/claude-fable-5-mythos-5) to both models on Jun 12, 2026 (stated as temporary). Pricing is retained so historical Fable 5 usage already in your session logs is costed correctly at the announced $10 / $50 per-MTok rates.
>
> **Note — legacy tiers:** The 0.1× / 1.25× / 2× multipliers describe current models. Claude 3 Haiku predates them and uses Anthropic's originally-published cache rates ($0.30 write / $0.03 read), and 1-hour cache-write rates for retired tiers (e.g. Sonnet 3.7, Haiku 3) are derived at 2× input. These legacy rows are kept only to cost older session logs accurately.

### Line Survival

Line survival uses an approximate heuristic: if lines added in commit A are deleted by a subsequent commit on the same file within 24 hours, they're counted as "churned." This is not git-blame-based tracking and survival rates are rounded to the nearest 5%.

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
    ├── server.js         # Express server + API routes
    └── dashboard.html    # Single-file dashboard (inline CSS/JS)
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
