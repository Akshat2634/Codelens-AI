# ai-roi

**Agent Productivity-to-Cost Correlator** — Is your AI coding agent actually shipping code?

`ai-roi` ties Claude Code token usage to actual git output. It reads your local Claude Code session files, correlates them with git commits by timestamp, and serves a dashboard answering: *"Am I getting ROI from my AI coding agent?"*

- One command, zero config
- All data stays local
- Works with any git repo where you've used Claude Code

## Installation

### Option 1: Run directly (no install)

```bash
npx ai-roi
```

### Option 2: Install globally

```bash
# npm
npm install -g ai-roi

# pnpm
pnpm add -g ai-roi

# yarn
yarn global add ai-roi
```

Then run anywhere:

```bash
ai-roi
```

### Option 3: Clone and run from source

```bash
git clone https://github.com/AkshatSahu/ai-roi.git
cd ai-roi

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
npx ai-roi
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
| **Branch Awareness**  | What % of AI commits landed on main/master                      |
| **Peak Hours**        | Hour-of-day x day-of-week productivity heatmap                  |

## CLI Options

```bash
ai-roi                        # default: last 30 days, port 3457
ai-roi --days 90              # look back 90 days
ai-roi --port 8080            # custom port
ai-roi --no-open              # don't auto-open browser
ai-roi --json                 # dump all metrics as JSON to stdout
ai-roi --project techops      # filter to a specific project
ai-roi --refresh              # force full re-parse (ignore cache)
```

## Dashboard

The dashboard includes:

- **Hero stats** — total cost, commits shipped, cost per commit, ROI grade
- **Smart insights** — auto-generated observations about your usage patterns
- **Cost vs Output timeline** — dual-axis chart of daily cost and lines added
- **Model comparison** — cost breakdown by Claude model
- **Session length analysis** — which session sizes have the best ROI
- **Productivity heatmap** — GitHub-style grid showing when you're most productive
- **Sessions table** — sortable, expandable table with per-session metrics and matched commits

## How It Works

1. **Parses** JSONL session files from `~/.claude/projects/`
2. **Analyzes** git history from each repo you've worked in with Claude
3. **Correlates** sessions to commits by timestamp (during session + 30min buffer)
4. **Calculates** cost using Anthropic token pricing (input, output, cache read/write)
5. **Serves** an interactive dashboard on localhost

### Caching

Parsed session data is cached at `~/.cache/ai-roi/parsed-sessions.json`. On subsequent runs, only new or modified JSONL files are re-parsed, making startup near-instant. Use `--refresh` to force a full re-parse.

### Cost Calculation

Token costs are calculated per model family:

| Model  | Input   | Output  | Cache Read | Cache Write |
| ------ | ------- | ------- | ---------- | ----------- |
| Opus   | $15/M   | $75/M   | $1.50/M    | $18.75/M    |
| Sonnet | $3/M    | $15/M   | $0.30/M    | $3.75/M     |
| Haiku  | $0.25/M | $1.25/M | $0.025/M   | $0.3125/M   |

### Line Survival

Line survival uses an approximate heuristic: if lines added in commit A are deleted by a subsequent commit on the same file within 24 hours, they're counted as "churned." This is not git-blame-based tracking and survival rates are rounded to the nearest 5%.

## Project Structure

```
ai-roi/
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

## Contributing

Contributions welcome! Here's how to get started:

```bash
# 1. Fork the repo on GitHub

# 2. Clone your fork
git clone https://github.com/YOUR_USERNAME/ai-roi.git
cd ai-roi

# 3. Install dependencies
npm install

# 4. Run in dev mode (no auto-open browser)
node src/index.js --no-open

# 5. Make your changes and test
node src/index.js --json | head -30   # verify JSON output
node src/index.js --no-open           # test dashboard at localhost:3457

# 6. Submit a pull request
```

### Ideas for contributions

- Support for other AI coding tools (Copilot, Cursor, etc.)
- Git blame-based line survival tracking (more accurate than the 24h heuristic)
- Export dashboard as PDF/PNG
- Historical trend tracking across multiple runs
- Team/multi-user support
- Custom pricing configuration via CLI flag or config file

## Privacy

All data stays on your machine. The only network requests are for Chart.js and Inter font from CDNs. No telemetry, no data collection.

## License

MIT
