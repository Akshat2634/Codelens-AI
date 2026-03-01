import { getModelFamily } from './claude-parser.js';

const CHURN_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

function formatBigNumber(n) {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + 'B';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toString();
}

function formatDuration(minutes) {
  if (minutes < 60) return `${minutes} minutes`;
  const hrs = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (mins === 0) return `${hrs} hr${hrs > 1 ? 's' : ''}`;
  return `${hrs} hr${hrs > 1 ? 's' : ''} ${mins} min`;
}

function sessionTokens(s) {
  return s.totalInputTokens + s.totalOutputTokens + s.cacheReadTokens + s.cacheCreationTokens;
}

function computeTokenAnalytics(correlatedSessions, lineSurvival, totalCommits, totalLinesAdded, modelBreakdown) {
  // Aggregate token stats
  const totalInputTokens = correlatedSessions.reduce((s, c) => s + c.totalInputTokens, 0);
  const totalOutputTokens = correlatedSessions.reduce((s, c) => s + c.totalOutputTokens, 0);
  const totalCacheReadTokens = correlatedSessions.reduce((s, c) => s + c.cacheReadTokens, 0);
  const totalCacheCreationTokens = correlatedSessions.reduce((s, c) => s + c.cacheCreationTokens, 0);
  const totalAllTokens = totalInputTokens + totalOutputTokens + totalCacheReadTokens + totalCacheCreationTokens;

  // Token waste analysis
  const productiveSessions = correlatedSessions.filter(s => s.commitCount > 0);
  const orphanedSessions = correlatedSessions.filter(s => s.isOrphaned);

  const tokensProductive = productiveSessions.reduce((s, c) => s + sessionTokens(c), 0);
  const tokensOrphaned = orphanedSessions.reduce((s, c) => s + sessionTokens(c), 0);
  const tokensExploratory = totalAllTokens - tokensProductive - tokensOrphaned;

  const costOrphaned = orphanedSessions.reduce((s, c) => s + c.cost.totalCost, 0);

  const tokenEfficiencyRate = totalAllTokens > 0
    ? Math.round((tokensProductive / totalAllTokens) * 100)
    : 0;

  // Token-to-output ratios
  const tokensPerCommit = totalCommits > 0 ? Math.round(totalAllTokens / totalCommits) : 0;
  const tokensPerLineAdded = totalLinesAdded > 0 ? Math.round(totalAllTokens / totalLinesAdded) : 0;
  const tokensPerSurvivingLine = lineSurvival.surviving > 0
    ? Math.round(totalAllTokens / lineSurvival.surviving) : 0;
  const outputInputRatio = totalInputTokens > 0
    ? Math.round((totalOutputTokens / totalInputTokens) * 100) / 100 : 0;

  // Cache efficiency
  const totalRawInput = totalInputTokens + totalCacheReadTokens;
  const cacheHitRate = totalRawInput > 0
    ? Math.round((totalCacheReadTokens / totalRawInput) * 100) : 0;
  const totalCacheReadCost = correlatedSessions.reduce((s, c) => s + c.cost.cacheReadCost, 0);
  // Cache reads are 90% cheaper — savings = what it would have cost at full price minus what was paid
  const cacheSavingsDollars = totalCacheReadCost * 9;

  // Fun facts
  const funFacts = generateTokenFunFacts(totalAllTokens, totalOutputTokens);

  return {
    totalAllTokens,
    totalInputTokens,
    totalOutputTokens,
    totalCacheReadTokens,
    totalCacheCreationTokens,
    tokensProductive,
    tokensOrphaned,
    tokensExploratory,
    costOrphaned,
    tokenEfficiencyRate,
    tokensPerCommit,
    tokensPerLineAdded,
    tokensPerSurvivingLine,
    outputInputRatio,
    cacheHitRate,
    cacheSavingsDollars,
    funnel: {
      total: totalAllTokens,
      input: totalInputTokens,
      output: totalOutputTokens,
      cacheRead: totalCacheReadTokens,
      cacheCreation: totalCacheCreationTokens,
      productive: tokensProductive,
      orphaned: tokensOrphaned,
      exploratory: tokensExploratory,
    },
    funFacts,
  };
}

function generateTokenFunFacts(totalAllTokens, totalOutputTokens) {
  const facts = [];
  // ~0.75 words per token for English text
  const approxWords = Math.round(totalOutputTokens * 0.75);
  const novels = (approxWords / 80000).toFixed(1);
  if (parseFloat(novels) >= 0.1) {
    facts.push(`Claude generated ~${formatBigNumber(approxWords)} words of output — about ${novels} novels worth of text.`);
  }
  return facts;
}

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

function computeEfficiencyGrade(costPerCommit, survivalRate) {
  // Grade based on cost per commit (more meaningful than raw token count)
  if (costPerCommit <= 2 && survivalRate >= 90) return 'A';
  if (costPerCommit <= 5 && survivalRate >= 75) return 'B';
  if (costPerCommit <= 15 && survivalRate >= 50) return 'C';
  if (costPerCommit <= 40 && survivalRate >= 25) return 'D';
  return 'F';
}

function computeSessionGrade(session) {
  if (session.commitCount === 0) return 'F';
  const costPerCommit = session.cost.totalCost / session.commitCount;
  // Use 80 as a default survival (we don't have per-session survival)
  return computeEfficiencyGrade(costPerCommit, 80);
}

function generateInsights(summary, correlatedSessions, modelBreakdown, sessionBuckets, tokenAnalytics) {
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
    let mainText;
    if (pct < 30) {
      mainText = `${pct}% of AI-assisted commits landed on production — this is normal if you primarily work on feature branches.`;
    } else if (pct >= 70) {
      mainText = `${pct}% of AI-assisted commits landed directly on production.`;
    } else {
      mainText = `${pct}% of AI-assisted commits landed on production.`;
    }
    insights.push({
      type: pct >= 50 ? 'success' : 'info',
      text: mainText,
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
      text: `Average session duration: ${formatDuration(Math.round(avgDuration))}.`,
    });
  }

  // Average commit delay (time between session end and commit)
  const delays = [];
  for (const session of correlatedSessions) {
    if (session.commits.length === 0) continue;
    const sessionEnd = new Date(session.endTime).getTime();
    for (const c of session.commits) {
      const delay = c.timestampMs - sessionEnd;
      if (delay >= 0) delays.push(delay);
    }
  }
  if (delays.length > 0) {
    const avgDelayMs = delays.reduce((s, d) => s + d, 0) / delays.length;
    const avgDelayHours = avgDelayMs / (1000 * 60 * 60);
    if (avgDelayHours < 1) {
      insights.push({ type: 'success', text: `On average, commits happen ${formatDuration(Math.round(avgDelayHours * 60))} after a session ends.` });
    } else {
      insights.push({ type: 'info', text: `On average, commits happen ${avgDelayHours.toFixed(1)} hours after a session ends.` });
    }
  }

  // Uncommitted files insight
  const totalUncommitted = correlatedSessions.reduce((s, c) => s + (c.uncommittedFiles?.length || 0), 0);
  const totalWritten = correlatedSessions.reduce((s, c) => s + (c.filesWritten?.length || 0), 0);
  if (totalWritten > 0 && totalUncommitted > 0) {
    const pct = Math.round((totalUncommitted / totalWritten) * 100);
    if (pct >= 20) {
      insights.push({ type: 'info', text: `${pct}% of files Claude edited (${totalUncommitted}/${totalWritten}) were not found in any commit.` });
    }
  }

  // ---- Token-specific insights ----
  if (tokenAnalytics && tokenAnalytics.totalAllTokens > 0) {
    const t = tokenAnalytics;

    // Token efficiency overview
    const wastePct = t.totalAllTokens > 0
      ? Math.round((t.tokensOrphaned / t.totalAllTokens) * 100) : 0;
    insights.push({
      type: wastePct > 20 ? 'warning' : 'info',
      text: `You burned ${formatBigNumber(t.totalAllTokens)} tokens — ${t.tokenEfficiencyRate}% shipped code, ${wastePct}% was WASTED in sessions that produced nothing.`,
    });

    // Orphaned session token waste (alarming if >20%)
    if (wastePct > 20) {
      const orphanedCount = correlatedSessions.filter(s => s.isOrphaned).length;
      insights.push({
        type: 'warning',
        text: `${formatBigNumber(t.tokensOrphaned)} tokens went up in smoke across ${orphanedCount} orphaned sessions. That's $${t.costOrphaned.toFixed(2)} burned with zero output.`,
      });
    }

    // Cache savings
    if (t.cacheHitRate > 0) {
      insights.push({
        type: 'success',
        text: `Cache saved you ${formatBigNumber(t.totalCacheReadTokens)} tokens (${t.cacheHitRate}% of input) — $${t.cacheSavingsDollars.toFixed(2)} you didn't have to spend.`,
      });
    }

    // Model token efficiency comparison
    const modelFamiliesForTokens = Object.entries(modelBreakdown)
      .filter(([, d]) => d.tokensPerCommit !== null);
    if (modelFamiliesForTokens.length > 1) {
      const sorted = [...modelFamiliesForTokens].sort((a, b) => a[1].tokensPerCommit - b[1].tokensPerCommit);
      const best = sorted[0];
      const worst = sorted[sorted.length - 1];
      if (best[1].tokensPerCommit && worst[1].tokensPerCommit) {
        const ratio = (worst[1].tokensPerCommit / best[1].tokensPerCommit).toFixed(1);
        insights.push({
          type: 'info',
          text: `${capitalise(best[0])} burns ${formatBigNumber(best[1].tokensPerCommit)} tokens/commit vs ${formatBigNumber(worst[1].tokensPerCommit)} for ${capitalise(worst[0])} — ${ratio}x difference.`,
        });
      }
    }

    // Tokens per commit tip
    if (t.tokensPerCommit > 100000) {
      insights.push({
        type: 'tip',
        text: `You burn ${formatBigNumber(t.tokensPerCommit)} tokens per commit. Consider breaking work into smaller, focused sessions.`,
      });
    }
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

  const avgCost = totalCommits > 0 ? totalCost / totalCommits : 0;
  const overallGrade = totalCommits > 0
    ? computeEfficiencyGrade(avgCost, lineSurvival.survivalRate)
    : 'F';

  // ---- Daily timeline ----
  const dailyMap = new Map();
  for (const session of correlatedSessions) {
    const d = new Date(session.startTime);
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (!dailyMap.has(date)) {
      dailyMap.set(date, { date, cost: 0, sessions: 0, commits: 0, linesAdded: 0, linesDeleted: 0, netLines: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0 });
    }
    const day = dailyMap.get(date);
    day.cost += session.cost.totalCost;
    day.sessions++;
    day.commits += session.commitCount;
    day.linesAdded += session.linesAdded;
    day.linesDeleted += session.linesDeleted;
    day.netLines += session.netLines;
    day.inputTokens += session.totalInputTokens;
    day.outputTokens += session.totalOutputTokens;
    day.cacheReadTokens += session.cacheReadTokens;
    day.totalTokens += session.totalInputTokens + session.totalOutputTokens + session.cacheReadTokens + session.cacheCreationTokens;
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
    const sessionTotalTokens = Object.values(session.modelBreakdown)
      .reduce((s, d) => s + d.tokens, 0);

    for (const [model, data] of Object.entries(session.modelBreakdown)) {
      const family = getModelFamily(model) || 'unknown';
      if (!modelBreakdown[family]) {
        modelBreakdown[family] = { cost: 0, tokens: 0, sessions: 0, commits: 0, avgCostPerCommit: null, subModels: {} };
      }
      modelBreakdown[family].cost += data.cost;
      modelBreakdown[family].tokens += data.tokens;

      // Accumulate sub-model cost and tokens within this family
      if (!modelBreakdown[family].subModels[model]) {
        modelBreakdown[family].subModels[model] = { cost: 0, tokens: 0 };
      }
      modelBreakdown[family].subModels[model].cost   += data.cost;
      modelBreakdown[family].subModels[model].tokens += data.tokens;

      // Distribute sessions and commits proportionally by token share
      const share = sessionTotalTokens > 0 ? data.tokens / sessionTotalTokens : 0;
      modelBreakdown[family].sessions += share;
      modelBreakdown[family].commits += session.commitCount * share;
    }
  }
  for (const data of Object.values(modelBreakdown)) {
    data.sessions = Math.round(data.sessions);
    data.avgCostPerCommit = data.commits > 0 ? data.cost / data.commits : null;
    data.tokensPerCommit = data.commits > 0 ? Math.round(data.tokens / data.commits) : null;
    data.subModels = Object.fromEntries(
      Object.entries(data.subModels).sort(([, a], [, b]) => b.cost - a.cost)
    );
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
    // Place each commit at its actual timestamp, not the session start
    for (const commit of session.commits) {
      const d = new Date(commit.timestamp);
      const dayOfWeek = d.getDay(); // 0=Sun
      const hour = d.getHours();
      heatmap[dayOfWeek][hour]++;
    }
    // Cost is still attributed to session start time
    const sd = new Date(session.startTime);
    heatmapCost[sd.getDay()][sd.getHours()] += session.cost.totalCost;
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

  // ---- Cost breakdown by time period ----
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const startOfWeek = new Date(now); startOfWeek.setDate(now.getDate() - now.getDay());
  startOfWeek.setHours(0, 0, 0, 0);
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const mkPeriod = () => ({ cost: 0, sessions: 0, commits: 0, tokens: 0 });
  const costByPeriod = { today: mkPeriod(), week: mkPeriod(), month: mkPeriod(), allTime: mkPeriod() };
  for (const session of correlatedSessions) {
    const sDate = new Date(session.startTime);
    const sDateStr = `${sDate.getFullYear()}-${String(sDate.getMonth() + 1).padStart(2, '0')}-${String(sDate.getDate()).padStart(2, '0')}`;
    const sTok = session.totalInputTokens + session.totalOutputTokens + session.cacheReadTokens + session.cacheCreationTokens;
    costByPeriod.allTime.cost += session.cost.totalCost; costByPeriod.allTime.sessions++; costByPeriod.allTime.commits += session.commitCount; costByPeriod.allTime.tokens += sTok;
    if (sDate >= startOfMonth) { costByPeriod.month.cost += session.cost.totalCost; costByPeriod.month.sessions++; costByPeriod.month.commits += session.commitCount; costByPeriod.month.tokens += sTok; }
    if (sDate >= startOfWeek) { costByPeriod.week.cost += session.cost.totalCost; costByPeriod.week.sessions++; costByPeriod.week.commits += session.commitCount; costByPeriod.week.tokens += sTok; }
    if (sDateStr === todayStr) { costByPeriod.today.cost += session.cost.totalCost; costByPeriod.today.sessions++; costByPeriod.today.commits += session.commitCount; costByPeriod.today.tokens += sTok; }
  }

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
    costByPeriod,
  };

  // ---- Token analytics ----
  const tokenAnalytics = computeTokenAnalytics(correlatedSessions, lineSurvival, totalCommits, totalLinesAdded, modelBreakdown);

  const insights = generateInsights(summary, correlatedSessions, modelBreakdown, sessionBuckets, tokenAnalytics);

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      daysAnalyzed: days,
      startDate: correlatedSessions.length > 0
        ? new Date(Math.min(...correlatedSessions.map(s => new Date(s.startTime).getTime()))).toISOString()
        : null,
      endDate: correlatedSessions.length > 0
        ? new Date(Math.max(...correlatedSessions.map(s => new Date(s.startTime).getTime()))).toISOString()
        : null,
      defaultBranches: Object.fromEntries(
        Object.entries(commitsByRepo).map(([repo, a]) => [repo.split('/').pop(), a.defaultBranch]).filter(([, b]) => b)
      ),
    },
    summary,
    tokenAnalytics,
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
