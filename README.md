# Codelens AI

**[codelensai-dev.vercel.app](https://codelensai-dev.vercel.app/)**

**Agent Productivity-to-Cost Correlator** — Is your AI coding agent actually shipping code?

Codelens AI ties AI coding agent token usage to actual git output. It reads your local **Claude Code** and **OpenAI Codex CLI** session files, correlates them with git commits, and serves a dashboard answering: *"Am I getting ROI from my AI coding agents?"* When both agents have sessions, the dashboard adds **All Agents / Claude Code / OpenAI Codex** tabs so you can compare them side by side.

- One command, zero config
- All data stays local
- Supports Claude Code and OpenAI Codex CLI in one dashboard
- Works with any git repo where you've used either agent

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

### Troubleshooting: `npx codelens-ai` runs an old version

`npx codelens-ai` (no version pin) can resolve to an old copy instead of the
latest release — either a stale entry in npx's local cache, or a global
install already on your `$PATH` that npx reuses without checking the
registry. Old enough versions predate whole subcommands, so you'll see a
confusing error like:

```
error: too many arguments. Expected 0 arguments but got 1.
```

Every current release prints an "Update available" hint when this happens,
but if you're stuck on a version from before that check existed, fix it with
one of:

```bash
npx codelens-ai@latest report       # pin the version explicitly

npm uninstall -g codelens-ai        # remove a shadowing global install
# or
npm install -g codelens-ai@latest   # ...or just update it
```

## Prerequisites

- **Node.js >= 22.12** — [Download](https://nodejs.org/) (Node >= 22.15 to also read Codex's zstd-compressed archive rollouts)
- **Git** — installed and configured with `user.name` and `user.email`
- At least one supported agent with local session data:
  - **Claude Code** — [Claude Code](https://claude.com/claude-code) sessions at `~/.claude/projects/`
  - **OpenAI Codex CLI** — [Codex](https://developers.openai.com/codex) sessions at `~/.codex/sessions/` (`$CODEX_HOME` is honored)

## Quick Start

```bash
npx codelens-ai
```

This parses your `~/.claude/projects/` and `~/.codex/sessions/` data, analyzes your git repos, and opens a dashboard at `http://localhost:3457`.

## What It Measures

| Metric                | Description                                                     |
| --------------------- | --------------------------------------------------------------- |
| **Cost per Commit**   | How much each AI-assisted commit costs in tokens                |
| **AI Code Share**     | % of all merged lines this window written by AI — measured from git, not surveys |
| **Value Leak**        | $ and % of spend from sessions that produced zero committed code |
| **Line Survival Rate**| % of AI-written lines that survive 24h without being rewritten  |
| **Orphaned Sessions** | Sessions with 10+ messages that produced zero commits           |
| **ROI Grade (A-F)**   | Composite score based on tokens-per-commit and survival rate    |
| **Trailer Attribution** | `Co-authored-by` agent trailers confirm commit attribution (near-ground-truth) |
| **Model Comparison**  | Efficiency across Opus, Sonnet, Haiku, GPT-5 Codex, and more    |
| **Agent Comparison**  | Per-agent dashboard tabs (All / Claude Code / OpenAI Codex)     |
| **Branch Awareness**  | What % of AI commits landed on production                       |
| **Peak Hours**        | Hour-of-day x day-of-week productivity heatmap                  |
| **Autonomy Score**    | Composite A-F grade measuring how independently the agent works |
| **Autopilot Ratio**   | Assistant messages per user prompt (higher = more autonomous)   |
| **Self-Heal Score**   | % of bash calls that are test/lint commands (self-verification) |
| **Commit Velocity**   | Tool calls per commit (lower = more efficient)                  |

## CLI Options

```bash
codelens-ai                        # default: last 30 days, port 3457
codelens-ai --days 90              # look back 90 days
codelens-ai --port 8080            # custom port
codelens-ai --host 0.0.0.0         # expose the dashboard beyond localhost (off by default)
codelens-ai --no-open              # don't auto-open browser
codelens-ai --json                 # dump all metrics as JSON to stdout
codelens-ai --project techops      # filter to a specific project
codelens-ai --refresh              # force full re-parse (ignore cache)
codelens-ai --source codex         # analyze a single agent only: claude | codex
codelens-ai --offline              # skip the network pricing refresh (use cached/hardcoded rates)
codelens-ai --plan max20           # Claude subscription mode: effective $/commit vs your flat plan
codelens-ai --plan-cost 150        # custom Claude monthly subscription cost (USD)
codelens-ai --codex-plan plus      # ChatGPT/Codex subscription: free | go | plus | pro100 | pro | business | business-annual
codelens-ai --codex-plan-cost 40   # custom Codex monthly subscription cost (USD)
codelens-ai --claude-dir <path>    # override ~/.claude/projects (testing/CI)
codelens-ai --codex-dir <path>     # override ~/.codex/sessions (testing/CI)

codelens-ai report                 # print an ROI scorecard to the terminal
codelens-ai report --md            # export codelens-report.md (or --md <path>)
codelens-ai report --html          # export a self-contained codelens-report.html
codelens-ai statusline --install   # add the ROI statusline to Claude Code

codelens-ai daily                  # token usage & cost table by day (+ commits, $/commit)
codelens-ai weekly                 # ...by week (--start-of-week monday|sunday)
codelens-ai monthly                # ...by month
codelens-ai daily --breakdown      # nest per-model rows under each period
codelens-ai daily --json           # structured export (pipe to jq)

codelens-ai blocks                 # group usage into Claude's 5-hour billing windows
codelens-ai blocks --active        # just the open block: burn rate, time left, projection
codelens-ai blocks --recent        # only the last 3 days of blocks
codelens-ai blocks -t max          # warn against a token limit (a number, or "max")
```

### Usage tables (`codelens-ai daily|weekly|monthly`)

ccusage-style token accounting over the same analyzed window — Input / Output / Cache Create /
Cache Read / Total / Cost per period — plus the two ROI columns a pure usage tool can't give you:
**Commits** and **$/Commit**. All the shared analysis flags (`--days`, `--source`, `--project`,
`--claude-dir`, `--codex-dir`) apply.

### Billing blocks (`codelens-ai blocks`)

Claude bills usage in rolling **5-hour windows** (the window opens with your first message and lasts
exactly 5 hours). `blocks` groups every session's usage into those windows and shows per-block
tokens and cost, your **burn rate** (tokens/min and $/hr), and — for the block that's still open — a
linear **projection** of where it lands plus an optional quota gauge (`-t <n>` or `-t max`). Add
`--active` for just the current window, `--recent` for the last 3 days, `--session-length <hours>` to
change the window size, or `--json` for a structured export. Costs use Codelens's version-aware
per-token pricing, so the numbers match the rest of the tool.

### ROI report (`codelens-ai report`)

One command produces the "is my AI subscription paying for itself" artifact — in the terminal, or as
a self-contained Markdown/HTML one-pager you can hand to a manager to justify a Claude Max or
ChatGPT Pro seat:

- Spend (API-equivalent, with the estimated-pricing share flagged), plan utilization when `--plan`/`--codex-plan` is set
- Commits shipped, cost per commit (and effective $/commit on your flat plan), line survival
- **AI code share** — % of all merged lines this window that the AI wrote, measured from git
- **Value leak** — how much spend never became committed code
- Per-agent and per-model breakdowns, the attribution audit, and top insights

All analysis flags (`--days`, `--source`, `--plan`, `--project`, ...) work on `report` too.

### Claude Code statusline (`codelens-ai statusline`)

A one-line always-on HUD inside Claude Code, and the only statusline that shows **ROI** alongside burn:

```text
$4.20 session │ today $12.40 · 3 commits · $4.13/commit · A │ burn 2.6K/min · $0.23/hr │ 5h 84% (resets 1h15m) · wk 41% │ ctx 23%
```

- **Session cost** straight from Claude Code (exact, not estimated)
- **Today's spend, commits, and $/commit** from your last pipeline run
- **Burn rate** of the open 5-hour block — tokens/min (colored by the cache-excluded indicator) and
  $/hr — snapshotted by your last pipeline run and hidden once the window closes
- **Official 5-hour and weekly rate-limit usage** with a reset countdown when you're close — the
  numbers Anthropic's limiter actually enforces, not token-math estimates
- **Context-window pressure**

Install it with one command (backs up your settings file first, refuses to clobber an existing
statusline unless you pass `--force`):

```bash
npx codelens-ai statusline --install
```

Then run `npx codelens-ai` (or `codelens-ai report`) whenever you want the "today" ROI numbers refreshed.

### Effective cost (subscription mode)

By default costs are **API-equivalent** — what your usage *would* cost at pay-as-you-go token rates. If you're on a flat-rate plan, those dollars aren't what you actually pay. Pass `--plan` (`pro` = $20/mo, `max5` = $100/mo, `max20` = $200/mo) / `--plan-cost <usd>` for Claude, or `--codex-plan` (`free` = $0/mo, `go` = $8/mo, `plus` = $20/mo, `pro100` = $100/mo, `pro` = $200/mo, `business` = $25/seat/mo monthly, `business-annual` = $20/seat/mo annually) / `--codex-plan-cost <usd>` for ChatGPT/Codex, to add an **Effective Cost** panel that prorates your subscription to the analyzed window and shows:

- **Effective $/commit** and **$/surviving line** — your prorated fee ÷ output, the cost figures that actually reflect your bill.
- **Plan utilization** — API-equivalent value ÷ prorated fee (e.g. `3.2×` means you extracted ~3.2× your subscription in pay-as-you-go value). This is an estimate of value extracted, **not** realized savings.

## Dashboard

The dashboard includes:

- **Agent source tabs** — when both Claude Code and Codex sessions exist, switch between **All Agents**, **Claude Code**, and **OpenAI Codex** views; every section recomputes for the selected agent
- **Hero stats** — total cost, commits shipped, cost per commit, ROI grade, **AI code share**, and **value leak**
- **Attribution & Coverage** — per-commit confidence (high/medium/low) that a commit was really the AI's, `Co-authored-by` trailer confirmations, plus a reconciliation of AI-attributed vs co-authored vs organic (manual) lines, so the ROI numbers are auditable rather than a black box
- **Smart insights** — auto-generated observations about your usage patterns
- **Cost vs Output timeline** — dual-axis chart of daily cost and lines added
- **Model comparison** — cost breakdown by Claude model
- **Session length analysis** — which session sizes have the best ROI
- **Productivity heatmap** — GitHub-style grid showing when you're most productive
- **Agent Autonomy** — autonomy score badge, autopilot ratio, self-heal score, commit velocity, and top verification commands
- **Projects** — per-repository ROI: which repo your spend goes to, ranked by cost, with its share of spend, commits, $/commit, lines, and % on the default branch. Repos are identified by their git `origin` remote, so a clone, worktree, or moved checkout of the same repo counts as one project (not a duplicate card)
- **Sessions table** — sortable, expandable table with per-session metrics, matched commits, and autopilot ratio

## How It Works

1. **Parses** JSONL session files from `~/.claude/projects/` (Claude Code) and rollout files from `~/.codex/sessions/` (OpenAI Codex CLI — including `.jsonl.zst` archives on Node >= 22.15)
2. **Analyzes** git history from each repo you've worked in with either agent, including `Co-authored-by` agent trailers on each commit
3. **Correlates** sessions to commits by file overlap and timing — all agents correlate together, so a commit is attributed to at most one session; a commit stamped `Co-authored-by: Claude/Codex` is routed to the matching agent and counts as high-confidence attribution
4. **Calculates** cost using each provider's published API pricing (input, output, cache, and server-side web search when logged)
5. **Serves** an interactive dashboard on localhost with per-agent views

### Caching

Parsed session data is cached at `~/.cache/agent-analytics/parsed-sessions.json`. On subsequent runs, only new or modified JSONL files are re-parsed, making startup near-instant. Use `--refresh` to force a full re-parse.

### Cost Calculation

> **Auto-pricing new models:** the per-model tables below stay authoritative (they carry version, date, long-context, and cache-tier precision), but any model they don't recognize is priced automatically from [LiteLLM's public price map](https://github.com/BerriAI/litellm) (2,900+ models) — fetched on demand, cached to `~/.cache/agent-analytics/pricing.json` for ~24h, and refreshed with `--refresh`. So a brand-new model id is costed from its real published rate with no code change, instead of a rough estimate. Use `--offline` to skip the network entirely (cached/hardcoded rates only); if the fetch fails, it degrades to the cache and then to the hardcoded fallback. Hardcoded rates always win when both sources have a model.

Token costs are version-aware and calculated per model, accounting for the two prompt-cache write rates. Multipliers (relative to base input): **cache read = 0.1×**, **5-minute cache write = 1.25×**, **1-hour cache write = 2×**. Figures below are verified against [Anthropic's pricing](https://platform.claude.com/docs/en/about-claude/pricing) (per million tokens):

| Model | Input | Output | Cache Read | Cache Write (5m) | Cache Write (1h) |
| --- | --- | --- | --- | --- | --- |
| Fable 5 / Mythos 5 | $10/M | $50/M | $1.00/M | $12.50/M | $20/M |
| Opus 4.8 | $5/M | $25/M | $0.50/M | $6.25/M | $10/M |
| Opus 4.7 | $5/M | $25/M | $0.50/M | $6.25/M | $10/M |
| Opus 4.6 | $5/M | $25/M | $0.50/M | $6.25/M | $10/M |
| Opus 4.5 | $5/M | $25/M | $0.50/M | $6.25/M | $10/M |
| Opus 4.0/4.1 (legacy) | $15/M | $75/M | $1.50/M | $18.75/M | $30/M |
| Sonnet 5 (intro, through Aug 31 2026) | $2/M | $10/M | $0.20/M | $2.50/M | $4/M |
| Sonnet 5 (standard, from Sep 1 2026) | $3/M | $15/M | $0.30/M | $3.75/M | $6/M |
| Sonnet 3.7/4.0/4.5/4.6 | $3/M | $15/M | $0.30/M | $3.75/M | $6/M |
| Haiku 4.5 | $1/M | $5/M | $0.10/M | $1.25/M | $2/M |
| Haiku 3.5 | $0.80/M | $4/M | $0.08/M | $1.00/M | $1.60/M |
| Haiku 3 | $0.25/M | $1.25/M | $0.03/M | $0.30/M | $0.50/M |

> **Note — Claude Sonnet 5:** Sonnet 5 launched with [introductory pricing](https://www.anthropic.com/news/claude-sonnet-5) of $2 / $10 per MTok through Aug 31, 2026, reverting to standard Sonnet-tier $3 / $15 on Sep 1, 2026. Costs are priced by the rate in effect on each usage's date, so logs stay accurate across the cutover.
>
> **Note — Claude Fable 5 / Mythos 5:** Claude Fable 5 / Mythos 5 is generally available again — Anthropic [restored access](https://platform.claude.com/docs/en/about-claude/models/introducing-claude-fable-5) on Jul 1, 2026 after a temporary suspension (Jun 12–30, 2026). The $10 / $50 per-MTok rates apply to both live and historical Fable 5 usage in your session logs.
>
> **Note — legacy tiers:** The 0.1× / 1.25× / 2× multipliers describe current models. Claude 3 Haiku predates them and uses Anthropic's originally-published cache rates ($0.30 write / $0.03 read), and 1-hour cache-write rates for retired tiers (e.g. Sonnet 3.7, Haiku 3) are derived at 2× input. These legacy rows are kept only to cost older session logs accurately.
>
> **Note — billing modifiers and tools:** Claude Code usage rows carry `speed` and `inference_geo` when applicable. Opus 4.8/4.7 fast-mode rates and the 1.1× US-only inference multiplier stack with cache pricing. Server-side web search is charged only from the logged `server_tool_use.web_search_requests` count at $10 per 1,000 searches; a client-side `WebSearch` tool call alone is not assumed billable, and web fetch has no per-call fee.

#### OpenAI Codex models

Codex sessions are costed from the `token_count` events in each rollout file. In OpenAI's accounting, `cached_input_tokens` is a subset of `input_tokens` (cache reads are billed at the cached rate, there is no cache-write premium) and `reasoning_output_tokens` is a subset of `output_tokens` (reasoning is billed at the output rate, never double-counted). Server-side `web_search_call` entries add OpenAI's published web-search call fee. Rates per million tokens from [OpenAI's API pricing](https://developers.openai.com/api/docs/pricing):

| Model | Input | Cached Input | Output |
| --- | --- | --- | --- |
| GPT-5.5 | $5.00/M short, $10/M long context | $0.50/M short, $1/M long context | $30/M short, $45/M long context |
| GPT-5.5 Pro | $30/M short, $60/M long context | no published cached discount | $180/M short, $270/M long context |
| GPT-5.4 / 5.4 Mini / 5.4 Nano | $2.50 / $0.75 / $0.20/M | $0.25 / $0.075 / $0.02/M | $15 / $4.50 / $1.25/M |
| GPT-5.4 Pro | $30/M short, $60/M long context | no published cached discount | $180/M short, $270/M long context |
| GPT-5.3 Codex | $1.75/M | $0.175/M | $14/M |
| GPT-5.1 Codex (Max) / 5.1 / GPT-5 Codex / GPT-5 | $1.25/M | $0.125/M | $10/M |
| GPT-5.1 Codex Mini / GPT-5 Mini | $0.25/M | $0.025/M | $2/M |
| codex-mini-latest | $1.50/M | $0.375/M | $6/M |
| o3 (from Jun 10 2025 / before) | $2 / $10/M | $0.50 / $2.50/M | $8 / $40/M |
| o4-mini | $1.10/M | $0.275/M | $4.40/M |
| GPT-4.1 | $2.00/M | $0.50/M | $8/M |

> **Note — o3:** OpenAI cut o3 prices 80% on Jun 10, 2025; usage is priced by the rate in effect on its date.
>
> **Note — long context:** GPT-5.5 and GPT-5.4 publish separate short-context and long-context rates. Codex logs that use long-context billing are kept as separate model buckets (for example, `gpt-5.5[long]`) before aggregation so mixed sessions do not average incompatible rates.
>
> **Note — current Codex models:** OpenAI's Codex docs currently recommend GPT-5.5, GPT-5.4, and GPT-5.4 mini; `gpt-5.3-codex-spark` is a ChatGPT Pro research preview and is not available in the API at launch. `gpt-5.3-codex` remains priced for API/log history but is deprecated for ChatGPT sign-in.
>
> **Note — web search:** Codex `web_search_call` entries are costed at OpenAI's $10 per 1,000 calls; search content tokens remain part of normal token usage when billed by the API.
>
> **Note — unpriced models:** Models without a published API price (e.g. `gpt-5.3-codex-spark`, future releases) are costed at proxy rates and included in the dashboard's "estimated spend" warning instead of silently reading $0.
>
> **Note — subscriptions:** If you use Codex through a ChatGPT plan (Free/Go/Plus/Pro/Business), the dollar figures are **API-equivalent value**, not what you were billed — pass `--codex-plan` to see effective cost against your flat fee. API-key mode can also include published server-side tool-call fees when the rollout logs expose them.

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
    ├── codex-parser.js   # Parse OpenAI Codex CLI rollout files
    ├── cache.js          # Parsed data caching layer (per-source staleness)
    ├── git-analyzer.js   # Parse git log with branch awareness
    ├── correlator.js     # Match sessions to commits by file overlap + timing + trailers
    ├── metrics.js        # Calculate ROI metrics and insights
    ├── report.js         # `codelens-ai report` — terminal / Markdown / HTML ROI scorecard
    ├── statusline.js     # `codelens-ai statusline` — Claude Code statusline integration
    ├── server.js         # Express server + API routes (?source= views)
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

All data stays on your machine, and the dashboard binds to `127.0.0.1` by default so it is not visible to your network (pass `--host 0.0.0.0` to opt in). Chart.js is bundled and served locally; the only external request the dashboard makes is loading webfonts from Google Fonts (it falls back to system fonts offline). No telemetry, no data collection.

## License

MIT
