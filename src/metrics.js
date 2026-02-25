import { getModelFamily } from './claude-parser.js';

const CHURN_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

function computeLineSurvival(commitsByRepo) {
  let totalAdded = 0;
  let totalChurned = 0;

  for (const analysis of Object.values(commitsByRepo)) {
    const userCommits = analysis.commits;
    if (!userCommits.length) continue;

    // Group commits by file
    const fileTimeline = new Map();
    for (const commit of userCommits) {
      for (const file of commit.files) {
        if (!fileTimeline.has(file.path)) fileTimeline.set(file.path, []);
        fileTimeline.get(file.path).push({
          timestampMs: commit.timestampMs,
          added: file.added,
          deleted: file.deleted,
        });
      }
    }

    // For each file, check for churn within 24h
    for (const entries of fileTimeline.values()) {
      entries.sort((a, b) => a.timestampMs - b.timestampMs);
      for (let i = 0; i < entries.length; i++) {
        totalAdded += entries[i].added;
        if (i + 1 < entries.length) {
          const gap = entries[i + 1].timestampMs - entries[i].timestampMs;
          if (gap <= CHURN_WINDOW_MS) {
            const churned = Math.min(entries[i + 1].deleted, entries[i].added);
            totalChurned += churned;
          }
        }
      }
    }
  }

  const surviving = totalAdded - totalChurned;
  // Round to nearest 5% to avoid false precision
  const rawRate = totalAdded > 0 ? (surviving / totalAdded) * 100 : 100;
  const survivalRate = Math.round(rawRate / 5) * 5;

  return { totalAdded, totalChurned, surviving, survivalRate };
}

function computeEfficiencyGrade(tokensPerCommit, survivalRate) {
  if (tokensPerCommit <= 500_000 && survivalRate >= 90) return 'A';
  if (tokensPerCommit <= 1_000_000 && survivalRate >= 75) return 'B';
  if (tokensPerCommit <= 3_000_000 && survivalRate >= 50) return 'C';
  if (tokensPerCommit <= 10_000_000 && survivalRate >= 25) return 'D';
  return 'F';
}

function computeSessionGrade(session) {
  if (session.commitCount === 0) return 'F';
  const totalTokens = session.totalInputTokens + session.totalOutputTokens +
    session.cacheReadTokens + session.cacheCreationTokens;
  const tokensPerCommit = totalTokens / session.commitCount;
  // Use 80 as a default survival (we don't have per-session survival)
  return computeEfficiencyGrade(tokensPerCommit, 80);
}

function generateInsights(summary, correlatedSessions, modelBreakdown, sessionBuckets) {
  const insights = [];

  // Orphaned session rate
  const orphanedCount = correlatedSessions.filter(s => s.isOrphaned).length;
  if (orphanedCount > 0) {
    const pct = Math.round((orphanedCount / correlatedSessions.length) * 100);
    insights.push({
      type: 'warning',
      text: `${pct}% of your sessions (${orphanedCount}/${correlatedSessions.length}) produced zero commits — potential wasted effort.`,
    });
  }

  // Model comparison
  const modelFamilies = Object.entries(modelBreakdown).filter(([, d]) => d.sessions > 0);
  if (modelFamilies.length > 1) {
    const sorted = modelFamilies.sort((a, b) => (a[1].avgCostPerCommit || Infinity) - (b[1].avgCostPerCommit || Infinity));
    const best = sorted[0];
    const worst = sorted[sorted.length - 1];
    if (best[1].avgCostPerCommit && worst[1].avgCostPerCommit) {
      const ratio = (worst[1].avgCostPerCommit / best[1].avgCostPerCommit).toFixed(1);
      insights.push({
        type: 'info',
        text: `${capitalise(worst[0])} sessions cost ${ratio}x more per commit than ${capitalise(best[0])}.`,
      });
    }
  }

  // Session length sweet spot
  const bucketEntries = Object.entries(sessionBuckets).filter(([, d]) => d.sessions > 0 && d.avgCostPerCommit !== null);
  if (bucketEntries.length > 1) {
    const bestBucket = bucketEntries.reduce((a, b) =>
      (a[1].avgCostPerCommit || Infinity) < (b[1].avgCostPerCommit || Infinity) ? a : b
    );
    insights.push({
      type: 'tip',
      text: `Sessions with ${bestBucket[0]} messages have the best cost-per-commit ($${bestBucket[1].avgCostPerCommit.toFixed(2)}).`,
    });
  }

  // Peak productivity hours
  if (summary.totalCommits > 0) {
    // Best day of week
    const bestDay = summary.bestDay;
    const worstDay = summary.worstDay;
    if (bestDay) {
      insights.push({
        type: 'success',
        text: `${bestDay.date} was your most productive AI day — ${bestDay.commits} commits for $${bestDay.cost.toFixed(2)}.`,
      });
    }
    if (worstDay && worstDay.date !== bestDay?.date) {
      insights.push({
        type: 'warning',
        text: `${worstDay.date} had the worst ROI — ${worstDay.commits} commits for $${worstDay.cost.toFixed(2)}.`,
      });
    }
  }

  // Commits on main
  const totalOnMain = correlatedSessions.reduce((s, cs) => s + cs.commitsOnMain, 0);
  if (summary.totalCommits > 0) {
    const pct = Math.round((totalOnMain / summary.totalCommits) * 100);
    insights.push({
      type: pct >= 50 ? 'success' : 'info',
      text: `${pct}% of AI-assisted commits landed on main/master.`,
    });
  }

  // Cost distribution
  if (summary.totalCost > 0) {
    const top20 = correlatedSessions
      .sort((a, b) => b.cost.totalCost - a.cost.totalCost)
      .slice(0, Math.max(1, Math.ceil(correlatedSessions.length * 0.2)));
    const top20Cost = top20.reduce((s, c) => s + c.cost.totalCost, 0);
    const pct = Math.round((top20Cost / summary.totalCost) * 100);
    if (pct >= 60) {
      insights.push({
        type: 'info',
        text: `Top 20% of sessions account for ${pct}% of total cost.`,
      });
    }
  }

  // Average session duration insight
  const avgDuration = correlatedSessions.reduce((s, c) => s + c.durationMinutes, 0) / correlatedSessions.length;
  if (avgDuration > 0) {
    insights.push({
      type: 'info',
      text: `Average session duration: ${Math.round(avgDuration)} minutes.`,
    });
  }

  return insights;
}

function capitalise(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function computeMetrics(correlatedSessions, organicCommits, commitsByRepo, days) {
  // ---- Summary ----
  const totalCost = correlatedSessions.reduce((s, c) => s + c.cost.totalCost, 0);
  const totalSessions = correlatedSessions.length;
  const totalCommits = correlatedSessions.reduce((s, c) => s + c.commitCount, 0);
  const totalLinesAdded = correlatedSessions.reduce((s, c) => s + c.linesAdded, 0);
  const totalLinesDeleted = correlatedSessions.reduce((s, c) => s + c.linesDeleted, 0);
  const totalNetLines = totalLinesAdded - totalLinesDeleted;
  const totalFilesChanged = new Set(
    correlatedSessions.flatMap(c => c.commits.flatMap(co => co.files.map(f => f.path)))
  ).size;
  const totalInputTokens = correlatedSessions.reduce((s, c) => s + c.totalInputTokens, 0);
  const totalOutputTokens = correlatedSessions.reduce((s, c) => s + c.totalOutputTokens, 0);
  const orphanedCount = correlatedSessions.filter(s => s.isOrphaned).length;
  const totalCommitsOnMain = correlatedSessions.reduce((s, c) => s + c.commitsOnMain, 0);

  const lineSurvival = computeLineSurvival(commitsByRepo);

  const totalTokens = totalInputTokens + totalOutputTokens;
  const tokensPerCommit = totalCommits > 0 ? totalTokens / totalCommits : 0;
  const overallGrade = totalCommits > 0
    ? computeEfficiencyGrade(tokensPerCommit, lineSurvival.survivalRate)
    : 'F';

  // ---- Daily timeline ----
  const dailyMap = new Map();
  for (const session of correlatedSessions) {
    const date = session.startTime.slice(0, 10);
    if (!dailyMap.has(date)) {
      dailyMap.set(date, { date, cost: 0, sessions: 0, commits: 0, linesAdded: 0, linesDeleted: 0, netLines: 0 });
    }
    const day = dailyMap.get(date);
    day.cost += session.cost.totalCost;
    day.sessions++;
    day.commits += session.commitCount;
    day.linesAdded += session.linesAdded;
    day.linesDeleted += session.linesDeleted;
    day.netLines += session.netLines;
  }
  const daily = [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date));

  // Best/worst days
  const daysWithCommits = daily.filter(d => d.commits > 0);
  const bestDay = daysWithCommits.length > 0
    ? daysWithCommits.reduce((a, b) => (b.commits / Math.max(b.cost, 0.01)) > (a.commits / Math.max(a.cost, 0.01)) ? b : a)
    : null;
  const worstDay = daysWithCommits.length > 0
    ? daysWithCommits.reduce((a, b) => (b.commits / Math.max(b.cost, 0.01)) < (a.commits / Math.max(a.cost, 0.01)) ? b : a)
    : null;

  // ---- Model breakdown ----
  const modelBreakdown = {};
  for (const session of correlatedSessions) {
    for (const [model, data] of Object.entries(session.modelBreakdown)) {
      const family = getModelFamily(model) || 'unknown';
      if (!modelBreakdown[family]) {
        modelBreakdown[family] = { cost: 0, tokens: 0, sessions: 0, commits: 0, avgCostPerCommit: null };
      }
      modelBreakdown[family].cost += data.cost;
      modelBreakdown[family].tokens += data.tokens;
    }
    // Count sessions/commits per primary model
    const primaryFamily = getModelFamily(session.model) || 'unknown';
    if (!modelBreakdown[primaryFamily]) {
      modelBreakdown[primaryFamily] = { cost: 0, tokens: 0, sessions: 0, commits: 0, avgCostPerCommit: null };
    }
    modelBreakdown[primaryFamily].sessions++;
    modelBreakdown[primaryFamily].commits += session.commitCount;
  }
  for (const data of Object.values(modelBreakdown)) {
    data.avgCostPerCommit = data.commits > 0 ? data.cost / data.commits : null;
  }

  // ---- Tool breakdown ----
  const toolBreakdown = {};
  for (const session of correlatedSessions) {
    for (const [tool, count] of Object.entries(session.toolCalls)) {
      toolBreakdown[tool] = (toolBreakdown[tool] || 0) + count;
    }
  }

  // ---- Session length buckets ----
  const buckets = { '1-50': [], '51-100': [], '101-200': [], '200+': [] };
  for (const session of correlatedSessions) {
    const msgCount = session.userMessageCount + session.assistantMessageCount;
    if (msgCount <= 50) buckets['1-50'].push(session);
    else if (msgCount <= 100) buckets['51-100'].push(session);
    else if (msgCount <= 200) buckets['101-200'].push(session);
    else buckets['200+'].push(session);
  }
  const sessionBuckets = {};
  for (const [label, sessions] of Object.entries(buckets)) {
    const cost = sessions.reduce((s, c) => s + c.cost.totalCost, 0);
    const commits = sessions.reduce((s, c) => s + c.commitCount, 0);
    sessionBuckets[label] = {
      sessions: sessions.length,
      cost,
      commits,
      avgCostPerCommit: commits > 0 ? cost / commits : null,
    };
  }

  // ---- Heatmap (hour x day-of-week) ----
  const heatmap = Array.from({ length: 7 }, () => Array(24).fill(0));
  const heatmapCost = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const session of correlatedSessions) {
    const d = new Date(session.startTime);
    const dayOfWeek = d.getDay(); // 0=Sun
    const hour = d.getHours();
    heatmap[dayOfWeek][hour] += session.commitCount;
    heatmapCost[dayOfWeek][hour] += session.cost.totalCost;
  }

  // ---- Per-project breakdown ----
  const projectMap = new Map();
  for (const session of correlatedSessions) {
    const key = session.repoPath || 'unknown';
    if (!projectMap.has(key)) {
      projectMap.set(key, {
        repoPath: key,
        repoName: session.projectName || key.split('/').pop(),
        totalCost: 0, sessions: 0, commits: 0, linesAdded: 0, commitsOnMain: 0,
      });
    }
    const p = projectMap.get(key);
    p.totalCost += session.cost.totalCost;
    p.sessions++;
    p.commits += session.commitCount;
    p.linesAdded += session.linesAdded;
    p.commitsOnMain += session.commitsOnMain;
  }
  const projects = [...projectMap.values()].map(p => ({
    ...p,
    avgCostPerLine: p.linesAdded > 0 ? p.totalCost / p.linesAdded : null,
    mainBranchPct: p.commits > 0 ? Math.round((p.commitsOnMain / p.commits) * 100) : 0,
  }));

  // Add grades to sessions
  const sessionsWithGrades = correlatedSessions.map(s => ({
    ...s,
    grade: computeSessionGrade(s),
  }));

  const summary = {
    totalCost,
    totalSessions,
    totalCommits,
    totalLinesAdded,
    totalLinesDeleted,
    totalNetLines,
    totalFilesChanged,
    avgCostPerCommit: totalCommits > 0 ? totalCost / totalCommits : null,
    avgCostPerLine: totalLinesAdded > 0 ? totalCost / totalLinesAdded : null,
    totalInputTokens,
    totalOutputTokens,
    orphanedSessionRate: totalSessions > 0 ? Math.round((orphanedCount / totalSessions) * 100) : 0,
    lineSurvivalRate: lineSurvival.survivalRate,
    overallGrade,
    totalCommitsOnMain,
    mainBranchPct: totalCommits > 0 ? Math.round((totalCommitsOnMain / totalCommits) * 100) : 0,
    organicCommitCount: organicCommits.length,
    bestDay,
    worstDay,
  };

  const insights = generateInsights(summary, correlatedSessions, modelBreakdown, sessionBuckets);

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      daysAnalyzed: days,
    },
    summary,
    insights,
    daily,
    projects,
    sessions: sessionsWithGrades,
    modelBreakdown,
    toolBreakdown,
    sessionBuckets,
    lineSurvival,
    heatmap: { commits: heatmap, cost: heatmapCost },
    organicCommits,
  };
}
