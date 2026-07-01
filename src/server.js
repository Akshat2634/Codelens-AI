import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

export function createServer(initialPayload, rebuildFn) {
  const app = express();
  let payload = initialPayload;

  // Serve dashboard HTML
  const dashboardHtml = readFileSync(path.join(__dirname, 'dashboard.html'), 'utf-8');

  app.get('/', (_req, res) => {
    res.type('html').send(dashboardHtml);
  });

  // Serve Chart.js from the installed package instead of a CDN, so the
  // dashboard works offline and on networks that block third-party CDNs.
  // require.resolve gives dist/chart.cjs; the UMD bundle sits beside it.
  const chartJsFile = path.join(path.dirname(require.resolve('chart.js')), 'chart.umd.min.js');
  app.get('/vendor/chart.umd.min.js', (_req, res) => {
    res.type('application/javascript').sendFile(chartJsFile);
  });

  // Full payload (single fetch for dashboard)
  app.get('/api/all', (_req, res) => {
    res.json(payload);
  });

  // Re-run the full pipeline: clear cache, re-parse sessions, re-analyze git, recompute metrics
  app.post('/api/refresh', async (_req, res) => {
    if (!rebuildFn) return res.status(501).json({ error: 'Refresh not available' });
    try {
      console.log('  \x1b[36m▸\x1b[0m \x1b[36m[refresh]\x1b[0m Re-parsing sessions and recomputing metrics...');
      const newPayload = await rebuildFn();
      if (!newPayload) return res.status(404).json({ error: 'No sessions found after refresh' });
      payload = newPayload;
      console.log('  \x1b[32m✔\x1b[0m \x1b[32m[refresh]\x1b[0m Done');
      res.json({ ok: true });
    } catch (err) {
      console.error('  \x1b[31m✖\x1b[0m \x1b[31m[refresh]\x1b[0m Error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Hero stats + insights
  app.get('/api/summary', (_req, res) => {
    res.json({
      ...payload.meta,
      ...payload.summary,
      insights: payload.insights,
    });
  });

  // Daily timeline data for charts
  app.get('/api/timeline', (_req, res) => {
    res.json(payload.daily);
  });

  // All sessions with pagination
  app.get('/api/sessions', (req, res) => {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 50;
    const sortBy = req.query.sort || 'startTime';
    const order = req.query.order === 'asc' ? 1 : -1;
    const mainOnly = req.query.mainOnly === 'true';

    let sessions = payload.sessions;

    // Filter to main branch commits only if requested
    if (mainOnly) {
      sessions = sessions.map(s => {
        const mainCommits = s.commits.filter(c => c.onMain);
        return {
          ...s,
          commits: mainCommits,
          commitCount: mainCommits.length,
          linesAdded: mainCommits.reduce((sum, c) => sum + c.totalAdded, 0),
          linesDeleted: mainCommits.reduce((sum, c) => sum + c.totalDeleted, 0),
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
      if (typeof av === 'string') return order * av.localeCompare(String(bv));
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
  app.get('/api/models', (_req, res) => {
    res.json(payload.modelBreakdown);
  });

  // Hour x day heatmap
  app.get('/api/heatmap', (_req, res) => {
    res.json(payload.heatmap);
  });

  // Single session detail
  app.get('/api/session/:id', (req, res) => {
    const session = payload.sessions.find(s => s.sessionId === req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json(session);
  });

  // Projects breakdown
  app.get('/api/projects', (_req, res) => {
    res.json(payload.projects);
  });

  // Session buckets
  app.get('/api/buckets', (_req, res) => {
    res.json(payload.sessionBuckets);
  });

  // Tool usage
  app.get('/api/tools', (_req, res) => {
    res.json(payload.toolBreakdown);
  });

  // Line survival
  app.get('/api/survival', (_req, res) => {
    res.json(payload.lineSurvival);
  });

  // Token analytics
  app.get('/api/tokens', (_req, res) => {
    res.json(payload.tokenAnalytics);
  });

  // Autonomy metrics
  app.get('/api/autonomy', (_req, res) => {
    res.json(payload.autonomyMetrics);
  });

  // Weekly narrative report (this week vs prior)
  app.get('/api/narrative', (_req, res) => {
    res.json(payload.weeklyNarrative || null);
  });

  return app;
}
