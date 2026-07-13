// `codelens-ai mcp` — expose the ROI reports as MCP tools over stdio, so MCP
// clients (Claude Code, Claude Desktop, ...) can query usage and ROI in-chat.
//
// The handlers are thin wrappers over the same computed payloads the dashboard
// and CLI already render — no new metrics logic lives here. The pipeline runs
// once at startup; the `refresh` tool re-runs it on demand. Stdout belongs to
// the JSON-RPC transport, so the CLI wiring routes all progress to stderr.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { blocksJson, buildBlocks, filterRecentBlocks } from './blocks.js';
import { reportModel } from './report.js';
import { buildPeriodTable, periodTableJson } from './tables.js';

// Shared across most tools: which agent's view to answer from. Falls back to
// the combined view when per-agent views weren't computed (single-agent runs).
const SOURCE_PROP = {
  source: {
    type: 'string',
    enum: ['all', 'claude', 'codex'],
    description: "Agent to scope the answer to (default 'all'; per-agent views exist only when both agents have sessions)",
  },
};

export const MCP_TOOLS = [
  {
    name: 'roi_summary',
    title: 'ROI Summary',
    description: 'ROI scorecard for AI coding agents: grade, efficiency score, total spend, commits shipped, cost per commit, line survival, AI code share, value leak, per-agent and per-model breakdowns, and insights. The headline "is my AI subscription paying for itself" answer.',
    inputSchema: { type: 'object', properties: { ...SOURCE_PROP }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'usage',
    title: 'Usage by Period',
    description: 'Token usage and cost table aggregated by day, week, or month — input/output/cache tokens, cost, sessions, plus commits and cost-per-commit per period, with a per-model breakdown.',
    inputSchema: {
      type: 'object',
      properties: {
        period: { type: 'string', enum: ['daily', 'weekly', 'monthly'], description: 'Aggregation bucket (default daily)' },
        startOfWeek: { type: 'string', enum: ['monday', 'sunday'], description: 'Week boundary for weekly (default monday)' },
        ...SOURCE_PROP,
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'blocks',
    title: 'Billing Blocks',
    description: "Usage grouped into Claude's rolling 5-hour billing windows: per-block tokens and cost, burn rate (tokens/min, $/hr), and a projection for the currently open block.",
    inputSchema: {
      type: 'object',
      properties: {
        recent: { type: 'boolean', description: 'Only blocks from the last 3 days' },
        ...SOURCE_PROP,
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'sessions',
    title: 'Recent Sessions',
    description: 'Recent AI coding sessions with cost, commits shipped, lines added, and an efficiency grade per session, newest first.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Max sessions to return (default 20)' },
        ...SOURCE_PROP,
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'projects',
    title: 'Project ROI',
    description: 'Per-repository ROI: cost, sessions, commits, cost per commit, lines added, and % of commits on the default branch, per repo, ranked by spend.',
    inputSchema: { type: 'object', properties: { ...SOURCE_PROP }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'refresh',
    title: 'Refresh Reports',
    description: 'Force a full re-parse of agent session logs and git history, then report the refreshed session counts. Use when data seems stale.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

const schemaValidator = new AjvJsonSchemaValidator();
const toolValidators = new Map(MCP_TOOLS.map((tool) => [tool.name, schemaValidator.getValidator(tool.inputSchema)]));

const json = (data) => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  structuredContent: data,
});
const err = (message) => ({ content: [{ type: 'text', text: message }], isError: true });

function validateToolCall(name, args) {
  const validate = toolValidators.get(name);
  if (!validate) return `Unknown tool: ${name}`;
  const result = validate(args);
  return result.valid ? null : `Invalid arguments for ${name}: ${result.errorMessage}`;
}

function pickView(payloads, source) {
  if (source && source !== 'all' && !payloads[source]) return null;
  return payloads[source] || payloads.all;
}

/**
 * Execute one tool call against the current payloads.
 *   ctx.getPayloads() — returns the current { all, claude?, codex? } payloads (or null when no sessions)
 *   ctx.refresh()     — async; re-runs the pipeline and returns fresh payloads (or null)
 *   ctx.days          — the analyzed lookback window in days
 * Pure of transport concerns, so tests can drive it directly.
 */
export async function callMcpTool(name, args, ctx) {
  // A stdio client can initialize and list tools while the initial analysis is
  // still running. Tool calls wait for that shared load instead of observing a
  // misleading transient "no sessions" state.
  if (ctx.ready) await ctx.ready();

  const validationError = validateToolCall(name, args);
  if (validationError) return err(validationError);

  if (name === 'refresh') {
    const fresh = await ctx.refresh();
    if (!fresh) return err(ctx.getError?.() ?? 'Refresh completed, but no AI coding agent sessions were found in the analyzed window.');
    return json({
      refreshed: true,
      daysAnalyzed: ctx.days,
      sessions: fresh.all.sessions.length,
      sources: fresh.all.meta.sources,
    });
  }

  const payloads = ctx.getPayloads();
  if (!payloads) return err(ctx.getError?.() ?? `No AI coding agent sessions found in the last ${ctx.days} days. Nothing to report.`);
  const view = pickView(payloads, args.source);
  if (!view) return err(`No ${args.source} sessions in the analyzed window — that per-agent view was not computed. Use source "all".`);

  switch (name) {
    case 'roi_summary':
      return json(reportModel(view, args.source && args.source !== 'all' ? null : payloads));

    case 'usage': {
      const period = args.period || 'daily';
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - ctx.days);
      const table = buildPeriodTable(view.sessions, {
        period,
        startOfWeek: args.startOfWeek || 'monday',
        cutoffMs: cutoff.getTime(),
      });
      return json(periodTableJson(table, { source: view.meta.source, daysAnalyzed: ctx.days }));
    }

    case 'blocks': {
      let result = buildBlocks(view.sessions);
      if (args.recent) result = filterRecentBlocks(result, 3);
      return json(blocksJson(result, { source: view.meta.source, daysAnalyzed: ctx.days }));
    }

    case 'sessions': {
      const limit = args.limit || 20;
      const rows = [...view.sessions]
        .sort((a, b) => new Date(b.startTime) - new Date(a.startTime))
        .slice(0, limit)
        .map((s) => ({
          sessionId: s.sessionId,
          project: s.projectName,
          source: s.source || 'claude',
          startTime: s.startTime,
          endTime: s.endTime,
          cost: s.cost?.totalCost ?? 0,
          commits: s.commitCount,
          linesAdded: s.linesAdded,
          grade: s.grade,
        }));
      return json({ daysAnalyzed: ctx.days, source: view.meta.source, total: view.sessions.length, sessions: rows });
    }

    case 'projects': {
      const rows = [...(view.projects || [])]
        .sort((a, b) => b.totalCost - a.totalCost)
        .map((p) => ({
          name: p.repoName,
          remote: p.remoteSlug || null,
          cost: p.totalCost,
          sessions: p.sessions,
          commits: p.commits,
          costPerCommit: p.commits > 0 ? p.totalCost / p.commits : null,
          linesAdded: p.linesAdded,
          mainBranchPct: p.mainBranchPct,
        }));
      return json({ daysAnalyzed: ctx.days, source: view.meta.source, projects: rows });
    }

    default:
      return err(`Unknown tool: ${name}`);
  }
}

// Wire the SDK server: tools/list serves MCP_TOOLS, tools/call dispatches to
// callMcpTool. The caller connects it to a StdioServerTransport.
export function createMcpServer(ctx, version) {
  const server = new Server(
    { name: 'codelens-ai', version },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: MCP_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = req.params.arguments || {};
    const validationError = validateToolCall(req.params.name, args);
    if (validationError) throw new McpError(ErrorCode.InvalidParams, validationError);
    return callMcpTool(req.params.name, args, ctx);
  });
  return server;
}

export async function serveMcpStdio(ctx, version) {
  const server = createMcpServer(ctx, version);
  await server.connect(new StdioServerTransport());
  return server;
}
