import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createServer(payload) {
  const app = express();

  // Serve dashboard HTML
  const dashboardHtml = readFileSync(path.join(__dirname, 'dashboard.html'), 'utf-8');

  app.get('/', (req, res) => {
    res.type('html').send(dashboardHtml);
  });

  // Full payload (single fetch for dashboard)
  app.get('/api/all', (req, res) => {
    res.json(payload);
  });

  // Hero stats + insights
  app.get('/api/summary', (req, res) => {
    res.json({
      ...payload.meta,
      ...payload.summary,
      insights: payload.insights,
    });
  });

  // Daily timeline data for charts
  app.get('/api/timeline', (req, res) => {
    res.json(payload.daily);
  });

  // All sessions with pagination
  app.get('/api/sessions', (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
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

    // Sort
    sessions = [...sessions].sort((a, b) => {
      const av = a[sortBy] ?? 0;
      const bv = b[sortBy] ?? 0;
      if (typeof av === 'string') return order * av.localeCompare(bv);
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
    res.json(payload.modelBreakdown);
  });

  // Hour x day heatmap
  app.get('/api/heatmap', (req, res) => {
    res.json(payload.heatmap);
  });

  // Single session detail
  app.get('/api/session/:id', (req, res) => {
    const session = payload.sessions.find(s => s.sessionId === req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json(session);
  });

  // Projects breakdown
  app.get('/api/projects', (req, res) => {
    res.json(payload.projects);
  });

  // Session buckets
  app.get('/api/buckets', (req, res) => {
    res.json(payload.sessionBuckets);
  });

  // Tool usage
  app.get('/api/tools', (req, res) => {
    res.json(payload.toolBreakdown);
  });

  // Line survival
  app.get('/api/survival', (req, res) => {
    res.json(payload.lineSurvival);
  });

  // Token analytics
  app.get('/api/tokens', (req, res) => {
    res.json(payload.tokenAnalytics);
  });

  return app;
}
