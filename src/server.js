import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { commitLinesForSession } from './correlator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Locate the Chart.js UMD bundle to serve at /vendor. The bundle is vendored
// into this package (src/vendor) so the dashboard works offline and — crucially
// — does NOT depend on chart.js being fully resolvable at runtime. (npx caches
// have been observed shipping a partial chart.js: require.resolve succeeds but
// the sibling chart.umd.min.js is missing on disk, which used to 404 the chart
// script and leave the dashboard blank.) The bundled copy is authoritative;
// the node_modules copy is only a dev-time fallback if the vendored file is
// somehow absent.
function findChartJs() {
  const bundled = path.join(__dirname, 'vendor', 'chart.umd.min.js');
  if (existsSync(bundled)) return bundled;
  try {
    const resolved = path.join(path.dirname(require.resolve('chart.js')), 'chart.umd.min.js');
    if (existsSync(resolved)) return resolved;
  } catch {
    // chart.js not installed (it's a devDependency) — the vendored copy is the
    // source of truth; nothing to fall back to.
  }
  return null;
}

// The server holds one payload per agent source: `all` (every session), and —
// when more than one agent has sessions — per-agent views (`claude`, `codex`,
// `kimi`) computed over just that agent's sessions. Routes select the view via
// ?source=; an unknown or absent source falls back to `all`. A bare payload
// (no `.all`) is accepted for backward compatibility and treated as the `all` view.
function normalizePayloads(payloadOrMap) {
  if (payloadOrMap?.all) return payloadOrMap;
  return { all: payloadOrMap };
}

export function createServer(initialPayload, rebuildFn, opts = {}) {
  const app = express();
  let payloads = normalizePayloads(initialPayload);
  // Whitelist the source names: a raw payloads[req.query.source] lookup would
  // resolve prototype keys (?source=constructor) to functions instead of
  // falling back to `all`.
  const pick = (req) => {
    const source = req.query.source;
    if ((source === 'claude' || source === 'codex' || source === 'kimi' || source === 'all') && payloads[source]) {
      return payloads[source];
    }
    return payloads.all;
  };

  // Serve dashboard HTML
  const dashboardHtml = readFileSync(path.join(__dirname, 'dashboard.html'), 'utf-8');

  app.get('/', (_req, res) => {
    res.type('html').send(dashboardHtml);
  });

  // Serve the vendored Chart.js bundle instead of a CDN, so the dashboard works
  // offline and on networks that block third-party CDNs. Read into memory once
  // at startup (like dashboard.html above) rather than sendFile'd per request:
  // this removes any runtime filesystem dependency and the ENOENT race seen with
  // partially-extracted npx caches, where the file passes existsSync at boot but
  // is gone when send() re-stats it — throwing an unhandled 404 stack trace. If
  // the buffer loaded at boot, it is guaranteed to serve; if it genuinely could
  // not be read, we send an explicit, actionable error instead.
  // opts.chartJsPath lets tests point the route at a missing/alternate file to
  // exercise graceful degradation; production always resolves via findChartJs().
  const chartJsFile = opts.chartJsPath !== undefined ? opts.chartJsPath : findChartJs();
  let chartJsBundle = null;
  if (chartJsFile) {
    try {
      chartJsBundle = readFileSync(chartJsFile);
    } catch {
      chartJsBundle = null;
    }
  }
  app.get('/vendor/chart.umd.min.js', (_req, res) => {
    if (!chartJsBundle) {
      res.status(500).type('text/plain')
        .send('Chart.js bundle is missing from this installation. Try reinstalling: npm cache clean --force && npx codelens-ai@latest');
      return;
    }
    res.type('application/javascript').send(chartJsBundle);
  });

  // Full payload (single fetch for dashboard)
  app.get('/api/all', (req, res) => {
    res.json(pick(req));
  });

  // Re-run the full pipeline: clear cache, re-parse sessions, re-analyze git, recompute metrics
  app.post('/api/refresh', async (_req, res) => {
    if (!rebuildFn) return res.status(501).json({ error: 'Refresh not available' });
    try {
      console.log('  \x1b[36m▸\x1b[0m \x1b[36m[refresh]\x1b[0m Re-parsing sessions and recomputing metrics...');
      const newPayload = await rebuildFn();
      if (!newPayload) return res.status(404).json({ error: 'No sessions found after refresh' });
      payloads = normalizePayloads(newPayload);
      console.log('  \x1b[32m✔\x1b[0m \x1b[32m[refresh]\x1b[0m Done');
      res.json({ ok: true });
    } catch (err) {
      console.error('  \x1b[31m✖\x1b[0m \x1b[31m[refresh]\x1b[0m Error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Hero stats + insights
  app.get('/api/summary', (req, res) => {
    const payload = pick(req);
    res.json({
      ...payload.meta,
      ...payload.summary,
      insights: payload.insights,
    });
  });

  // Daily timeline data for charts
  app.get('/api/timeline', (req, res) => {
    res.json(pick(req).daily);
  });

  // All sessions with pagination
  app.get('/api/sessions', (req, res) => {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 50;
    const sortBy = req.query.sort || 'startTime';
    const order = req.query.order === 'asc' ? 1 : -1;
    const mainOnly = req.query.mainOnly === 'true';

    let sessions = pick(req).sessions;

    // Filter to main branch commits only if requested. Line counts keep the
    // same AI-attribution rule as the unfiltered view (session-file overlap via
    // commitLinesForSession), and derived per-commit fields are recomputed so
    // they don't reflect the unfiltered commit set.
    if (mainOnly) {
      sessions = sessions.map(s => {
        const mainCommits = s.commits.filter(c => c.onMain);
        let linesAdded = 0;
        let linesDeleted = 0;
        for (const c of mainCommits) {
          const { added, deleted } = commitLinesForSession(s, c);
          linesAdded += added;
          linesDeleted += deleted;
        }
        const netLines = linesAdded - linesDeleted;
        return {
          ...s,
          commits: mainCommits,
          commitCount: mainCommits.length,
          commitsOnMain: mainCommits.length,
          linesAdded,
          linesDeleted,
          netLines,
          costPerCommit: mainCommits.length > 0 ? s.cost.totalCost / mainCommits.length : null,
        };
      });
    }

    // Sort. Map compound/derived keys to sortable scalars — sorting the raw
    // property would silently no-op for 'cost' (an object) and 'msgCount'.
    const sortValue = (s) => {
      if (sortBy === 'cost' || sortBy === 'cost.totalCost') return s.cost?.totalCost ?? 0;
      if (sortBy === 'msgCount') return (s.userMessageCount || 0) + (s.assistantMessageCount || 0);
      return s[sortBy] ?? 0;
    };
    sessions = [...sessions].sort((a, b) => {
      const av = sortValue(a);
      const bv = sortValue(b);
      // Coerce both sides when either is a string: a null model (→ 0 via ?? 0)
      // compared against a string id would hit the numeric branch and yield
      // NaN — an unstable, arbitrary order. String(0) groups nulls together.
      if (typeof av === 'string' || typeof bv === 'string') {
        return order * String(av).localeCompare(String(bv));
      }
      return order * (av - bv);
    });

    const start = (page - 1) * limit;
    res.json({
      sessions: sessions.slice(start, start + limit),
      total: sessions.length,
      page,
      limit,
    });
  });

  // Model comparison data
  app.get('/api/models', (req, res) => {
    res.json(pick(req).modelBreakdown);
  });

  // Hour x day heatmap
  app.get('/api/heatmap', (req, res) => {
    res.json(pick(req).heatmap);
  });

  // Single session detail
  app.get('/api/session/:id', (req, res) => {
    const session = pick(req).sessions.find(s => s.sessionId === req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json(session);
  });

  // Projects breakdown
  app.get('/api/projects', (req, res) => {
    res.json(pick(req).projects);
  });

  // Session buckets
  app.get('/api/buckets', (req, res) => {
    res.json(pick(req).sessionBuckets);
  });

  // Tool usage
  app.get('/api/tools', (req, res) => {
    res.json(pick(req).toolBreakdown);
  });

  // Skill usage (Claude Code Skill invocations, by skill name)
  app.get('/api/skills', (req, res) => {
    res.json(pick(req).skillBreakdown);
  });

  // MCP server usage, grouped from mcp__<server>__<tool> tool calls
  app.get('/api/mcp-servers', (req, res) => {
    res.json(pick(req).mcpServerBreakdown);
  });

  // Sessions by client surface (entrypoint: cli, claude-vscode, codex-cli, ...)
  app.get('/api/clients', (req, res) => {
    res.json(pick(req).clientBreakdown);
  });

  // Sessions by agent type (main_only vs delegated to a subagent)
  app.get('/api/agent-type', (req, res) => {
    res.json(pick(req).agentTypeBreakdown);
  });

  // Feature adoption — share of sessions using Sub-agents / Skills / MCP / Plan mode
  app.get('/api/feature-adoption', (req, res) => {
    res.json(pick(req).featureAdoption);
  });

  // Line survival
  app.get('/api/survival', (req, res) => {
    res.json(pick(req).lineSurvival);
  });

  // Token analytics
  app.get('/api/tokens', (req, res) => {
    res.json(pick(req).tokenAnalytics);
  });

  // Autonomy metrics
  app.get('/api/autonomy', (req, res) => {
    res.json(pick(req).autonomyMetrics);
  });

  // Weekly narrative report (this week vs prior)
  app.get('/api/narrative', (req, res) => {
    res.json(pick(req).weeklyNarrative || null);
  });

  return app;
}
