import { getModelFamily, PLAN_PRICING } from './claude-parser.js';

const CHURN_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

// Premium-model families: spend here is the first lever to question when costs run high.
const PREMIUM_FAMILIES = new Set(['opus']);
// Published reference thresholds (used for benchmark bands in the UI).
// AI-era code churn baseline ≈ 7-8% (GitClear); revert/rework top-quartile < 4% (DORA-style).
const BENCHMARKS = {
  churnRatePct: { good: 8, warn: 15 },
  reworkRatePct: { good: 4, warn: 10 },
  cacheHitRatePct: { good: 80, warn: 50 },
  premiumSharePct: { good: 30, warn: 60 },
};

function formatBigNumber(n) {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + 'B';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toString();
}

function sessionTokens(s) {
  return s.totalInputTokens + s.totalOutputTokens + s.cacheReadTokens + s.cacheCreationTokens;
}

function computeTokenAnalytics(correlatedSessions, lineSurvival, totalCommits, totalLinesAdded, _modelBreakdown) {
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
  // Estimated cache savings. Cache reads are billed at ~0.1x the base input rate
  // across every pricing tier, so the avoided cost ≈ 9x what was actually paid for
  // those reads. Labelled as an estimate in the UI (and only meaningful on the API plan).
  const cacheSavingsDollars = totalCacheReadCost * 9;

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
  };
}

function buildWeeklyNarrative(correlatedSessions, _autonomyMetrics) {
  if (!correlatedSessions.length) return null;

  const now = Date.now();
  const WEEK_MS = 7 * 24 * 3600 * 1000;
  const thisStart = now - WEEK_MS;
  const lastStart = now - 2 * WEEK_MS;

  // Lines added for a single commit, mirroring the correlator's session-level
  // overlap rule (filesWritten ∩ commit.files), so headline numbers match
  // session.linesAdded in aggregate.
  const commitLinesAdded = (s, c) => {
    const sessionFiles = new Set(s.filesWritten || []);
    return sessionFiles.size > 0
      ? c.files.filter(f => sessionFiles.has(f.path)).reduce((a, f) => a + f.added, 0)
      : c.totalAdded;
  };

  const aggregate = (startMs, endMs) => {
    // Session-level metrics (cost, tokens, msgs, model spend) bucket by session start.
    const ss = correlatedSessions.filter(s => {
      const t = new Date(s.startTime).getTime();
      return t >= startMs && t < endMs;
    });
    const cost = ss.reduce((a, b) => a + b.cost.totalCost, 0);
    const tokens = ss.reduce((a, b) => a + b.totalInputTokens + b.totalOutputTokens + b.cacheReadTokens + b.cacheCreationTokens, 0);
    const msgUser = ss.reduce((a, b) => a + b.userMessageCount, 0);
    const msgAssistant = ss.reduce((a, b) => a + b.assistantMessageCount, 0);
    const autopilot = msgUser > 0 ? msgAssistant / msgUser : 0;

    const modelCost = {};
    for (const s of ss) {
      for (const [m, data] of Object.entries(s.modelBreakdown)) {
        const fam = getModelFamily(m) || 'unknown';
        modelCost[fam] = (modelCost[fam] || 0) + data.cost;
      }
    }
    const dominantModel = Object.entries(modelCost).sort((a, b) => b[1] - a[1])[0] || null;

    // Output metrics (commits, lines, lines-by-model) bucket by commit author time.
    let commits = 0;
    let linesAdded = 0;
    const modelLines = {};
    for (const s of correlatedSessions) {
      const sessionTokens = Object.values(s.modelBreakdown).reduce((sum, d) => sum + d.tokens, 0);
      for (const c of (s.commits || [])) {
        if (c.timestampMs < startMs || c.timestampMs >= endMs) continue;
        commits++;
        const cLines = commitLinesAdded(s, c);
        linesAdded += cLines;
        for (const [m, data] of Object.entries(s.modelBreakdown)) {
          const fam = getModelFamily(m) || 'unknown';
          const share = sessionTokens > 0 ? data.tokens / sessionTokens : 0;
          modelLines[fam] = (modelLines[fam] || 0) + cLines * share;
        }
      }
    }

    const costPerCommit = commits > 0 ? cost / commits : null;

    return { sessions: ss.length, cost, commits, linesAdded, tokens, autopilot, costPerCommit, dominantModel, modelCost, modelLines };
  };

  const thisWeek = aggregate(thisStart, now);
  const lastWeek = aggregate(lastStart, thisStart);

  if (thisWeek.sessions === 0) return null;

  const deltaPct = (curr, prev) => {
    if (prev === null || prev === undefined || prev === 0 || curr === null || curr === undefined) return null;
    return Math.round(((curr - prev) / prev) * 100);
  };

  // Headline
  let headline;
  if (thisWeek.commits > 0 && thisWeek.costPerCommit !== null) {
    headline = `You shipped ${thisWeek.commits} commit${thisWeek.commits === 1 ? '' : 's'} at $${thisWeek.costPerCommit.toFixed(2)} each`;
    const d = deltaPct(thisWeek.costPerCommit, lastWeek.costPerCommit);
    if (d !== null) {
      if (d <= -15) headline += ` — ${Math.abs(d)}% cheaper than last week.`;
      else if (d >= 15) headline += ` — ${d}% pricier than last week.`;
      else headline += ` — on par with last week.`;
    } else if (lastWeek.sessions === 0) {
      headline += ` — first week of measured activity.`;
    } else {
      headline += `.`;
    }
  } else {
    headline = `${thisWeek.sessions} session${thisWeek.sessions === 1 ? '' : 's'} this week — no commits matched yet.`;
  }

  const metrics = [
    { label: 'Commits', value: String(thisWeek.commits), deltaPct: deltaPct(thisWeek.commits, lastWeek.commits), direction: 'higher-better' },
    { label: 'Spend', value: '$' + thisWeek.cost.toFixed(2), deltaPct: deltaPct(thisWeek.cost, lastWeek.cost), direction: 'lower-better' },
    { label: 'Cost/Commit', value: thisWeek.costPerCommit !== null ? '$' + thisWeek.costPerCommit.toFixed(2) : '—', deltaPct: deltaPct(thisWeek.costPerCommit, lastWeek.costPerCommit), direction: 'lower-better' },
    { label: 'Lines Added', value: thisWeek.linesAdded.toLocaleString(), deltaPct: deltaPct(thisWeek.linesAdded, lastWeek.linesAdded), direction: 'higher-better' },
  ];

  const bullets = [];
  if (thisWeek.dominantModel && thisWeek.cost > 0) {
    const [fam, famCost] = thisWeek.dominantModel;
    const costPct = Math.round((famCost / thisWeek.cost) * 100);
    const famLines = thisWeek.modelLines[fam] || 0;
    const linesPct = thisWeek.linesAdded > 0 ? Math.round((famLines / thisWeek.linesAdded) * 100) : 0;
    if (linesPct > 0) {
      bullets.push(`${capitalise(fam)} carried ${costPct}% of spend and ~${linesPct}% of lines shipped.`);
    } else {
      bullets.push(`${capitalise(fam)} carried ${costPct}% of this week's cost.`);
    }
  }
  if (thisWeek.autopilot > 0) {
    bullets.push(`Autopilot ratio: ${thisWeek.autopilot.toFixed(1)}x — your agent handled ${thisWeek.autopilot.toFixed(1)} actions per prompt.`);
  }

  // Best day inside the week — bucket by commit author time. Cost for the day
  // is attributed proportionally: each commit inherits sessionCost / commitCount
  // from its parent session so the dollar figure tracks the commits shown.
  const commitsByDay = {};
  for (const s of correlatedSessions) {
    const perCommitCost = s.commitCount > 0 ? s.cost.totalCost / s.commitCount : 0;
    for (const c of (s.commits || [])) {
      if (c.timestampMs < thisStart || c.timestampMs >= now) continue;
      const dt = new Date(c.timestampMs);
      const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
      if (!commitsByDay[key]) commitsByDay[key] = { commits: 0, cost: 0 };
      commitsByDay[key].commits++;
      commitsByDay[key].cost += perCommitCost;
    }
  }
  const bestDayEntry = Object.entries(commitsByDay).sort((a, b) => b[1].commits - a[1].commits)[0];
  if (bestDayEntry) {
    const [dateStr, { commits: dCommits, cost: dCost }] = bestDayEntry;
    const dn = new Date(dateStr + 'T12:00:00');
    const dayLabel = dn.toLocaleDateString(undefined, { weekday: 'long' });
    bullets.push(`${dayLabel} was your most productive day — ${dCommits} commit${dCommits === 1 ? '' : 's'} for $${dCost.toFixed(2)}.`);
  }

  // Efficiency trend flag
  if (thisWeek.commits >= 3 && lastWeek.costPerCommit !== null && thisWeek.costPerCommit !== null) {
    const d = deltaPct(thisWeek.costPerCommit, lastWeek.costPerCommit);
    if (d !== null && d <= -20) bullets.push(`Your efficiency jumped meaningfully — keep the momentum.`);
    else if (d !== null && d >= 20) bullets.push(`Cost-per-commit is trending up — consider shorter, focused sessions.`);
  }

  return {
    headline,
    weekRange: { start: new Date(thisStart).toISOString(), end: new Date(now).toISOString() },
    metrics,
    bullets,
    thisWeek: {
      sessions: thisWeek.sessions,
      cost: Math.round(thisWeek.cost * 100) / 100,
      commits: thisWeek.commits,
      linesAdded: thisWeek.linesAdded,
      costPerCommit: thisWeek.costPerCommit !== null ? Math.round(thisWeek.costPerCommit * 100) / 100 : null,
    },
    priorWeek: {
      sessions: lastWeek.sessions,
      cost: Math.round(lastWeek.cost * 100) / 100,
      commits: lastWeek.commits,
      costPerCommit: lastWeek.costPerCommit !== null ? Math.round(lastWeek.costPerCommit * 100) / 100 : null,
    },
  };
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

// ---- Autonomy metrics ----
function computeAutonomyGrade(score) {
  if (score >= 80) return 'A';
  if (score >= 60) return 'B';
  if (score >= 40) return 'C';
  if (score >= 20) return 'D';
  return 'F';
}

function computeAutonomyMetrics(correlatedSessions) {
  const perSession = correlatedSessions.map(s => {
    const autopilotRatio = s.userMessageCount > 0
      ? Math.round((s.assistantMessageCount / s.userMessageCount) * 100) / 100
      : 0;

    const selfHealScore = s.totalBashCalls > 0
      ? Math.round((s.verificationBashCalls / s.totalBashCalls) * 100)
      : 0;

    const totalToolCalls = Object.values(s.toolCalls).reduce((sum, c) => sum + c, 0);
    const commitVelocity = s.commitCount > 0 ? Math.round(totalToolCalls / s.commitCount) : null;

    return { sessionId: s.sessionId, autopilotRatio, selfHealScore, commitVelocity };
  });

  // Aggregates
  const totalUser = correlatedSessions.reduce((s, c) => s + c.userMessageCount, 0);
  const totalAssistant = correlatedSessions.reduce((s, c) => s + c.assistantMessageCount, 0);
  const autopilotRatio = totalUser > 0
    ? Math.round((totalAssistant / totalUser) * 100) / 100
    : 0;

  const totalBash = correlatedSessions.reduce((s, c) => s + (c.totalBashCalls || 0), 0);
  const totalVerif = correlatedSessions.reduce((s, c) => s + (c.verificationBashCalls || 0), 0);
  const selfHealScore = totalBash > 0 ? Math.round((totalVerif / totalBash) * 100) : 0;

  const withCommits = perSession.filter(a => a.commitVelocity !== null);
  const commitVelocity = withCommits.length > 0
    ? Math.round(withCommits.reduce((s, a) => s + a.commitVelocity, 0) / withCommits.length)
    : null;

  // Composite score (0-100): clamp and weight each component. Toolbelt coverage was
  // dropped (its fixed 14-tool denominator is meaningless once MCP/custom tools exist),
  // so the remaining weight shifts onto self-healing — the strongest quality signal.
  const autopilotScore = Math.round(Math.min(autopilotRatio / 5, 1) * 100);
  const selfHealWeighted = selfHealScore;
  const velocityScore = commitVelocity !== null
    ? Math.round(Math.max(0, Math.min(1, 1 - (commitVelocity / 100))) * 100)
    : 50; // neutral when no commits

  const overallScore = Math.round(
    autopilotScore * 0.30 +
    selfHealWeighted * 0.40 +
    velocityScore * 0.30
  );

  // Top verification commands — extract the actual test/lint command, stripping cd/path prefixes
  const verifCounts = {};
  for (const s of correlatedSessions) {
    for (const bc of (s.bashCommands || [])) {
      if (bc.isVerification) {
        // Strip "cd /path && ", "cd /path;", and "VAR=val " prefixes to get the real command
        const stripped = bc.command
          .replace(/^(?:cd\s+\S+\s*&&\s*)+/g, '')
          .replace(/^(?:cd\s+\S+\s*;\s*)+/g, '')
          .replace(/^(?:\w+=\S+\s+)+/g, '')
          .trim();
        const key = stripped.split(' ').slice(0, 3).join(' ') || bc.command.split(' ').slice(0, 3).join(' ');
        verifCounts[key] = (verifCounts[key] || 0) + 1;
      }
    }
  }
  const topVerificationCommands = Object.entries(verifCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([command, count]) => ({ command, count }));

  return {
    overall: { score: overallScore, grade: computeAutonomyGrade(overallScore) },
    autopilotRatio,
    selfHealScore,
    commitVelocity,
    totalBashCalls: totalBash,
    totalVerificationCalls: totalVerif,
    topVerificationCommands,
    perSession,
    breakdown: { autopilotScore, selfHealWeighted, velocityScore },
  };
}

function scoreToLetter(score) {
  return score >= 80 ? 'A' : score >= 60 ? 'B' : score >= 40 ? 'C' : score >= 20 ? 'D' : 'F';
}

// Single source of truth for the ROI grade. Weighted toward durability (survival)
// over raw cost efficiency, per the SPACE/DX-Core-4 guidance that output volume must
// be counterbalanced by quality. 60 pts survival + 40 pts cost efficiency.
function computeEfficiencyScore(costPerCommit, survivalRate, orphanedRate, totalCommits) {
  if (totalCommits === 0) {
    return {
      score: 0, tier: 'Getting Started', letter: 'F',
      explanation: 'No commits matched to sessions yet — this is normal for exploratory work.',
      tip: 'Commits are matched by file overlap with Claude-edited files.',
    };
  }

  let costScore;
  if (costPerCommit <= 2) costScore = 40;
  else if (costPerCommit >= 50) costScore = 0;
  else costScore = Math.max(0, 40 * (1 - Math.log(costPerCommit / 2) / Math.log(25)));
  const survivalScore = Math.min(survivalRate, 100) / 100 * 60;
  const score = Math.round(costScore + survivalScore);

  const tier = score >= 80 ? 'Excellent' : score >= 60 ? 'Solid' : score >= 40 ? 'Developing' : score >= 20 ? 'Early' : 'Getting Started';
  const letter = scoreToLetter(score);

  // Build explanation from actual metrics
  const costAdj = costPerCommit <= 2 ? 'excellent' : costPerCommit <= 5 ? 'good' : costPerCommit <= 15 ? 'moderate' : 'high';
  const explanation = `$${costPerCommit.toFixed(2)}/commit (${costAdj}) · ${Math.round(survivalRate)}% code survival`;

  // Actionable tip based on weakest metric (survival weighted heavier, so flag it first)
  let tip;
  if (survivalRate < 50) {
    tip = 'Review AI-generated code before committing to improve survival rate.';
  } else if (costScore / 40 < survivalScore / 60) {
    tip = 'Try shorter, focused sessions to reduce cost per commit.';
  } else if (orphanedRate > 40) {
    tip = `${orphanedRate}% of sessions had no commits — some may be exploratory, which is fine.`;
  } else {
    tip = 'Keep it up — your efficiency is on track.';
  }

  return { score, tier, letter, explanation, tip };
}

// Per-session grade reflects cost-per-commit ONLY — there is no per-session survival
// signal (that requires the blame engine), so we deliberately do not fake a quality
// component here. Labelled as a cost grade in the UI.
function computeSessionGrade(session) {
  if (session.commitCount === 0) return 'F';
  const costPerCommit = session.cost.totalCost / session.commitCount;
  if (costPerCommit <= 3) return 'A';
  if (costPerCommit <= 8) return 'B';
  if (costPerCommit <= 20) return 'C';
  if (costPerCommit <= 50) return 'D';
  return 'F';
}

function generateInsights(summary, correlatedSessions, modelBreakdown, sessionBuckets, tokenAnalytics, autonomyMetrics, costControl) {
  // Insights are deliberately curated to avoid repeating what's already shown
  // on hero cards (cost/tokens/cache), the weekly narrative (best day, autopilot,
  // dominant model), or the autonomy section (self-heal, toolbelt, bash counts).
  // Lower priority number = higher urgency. Capped at 8 after sorting.
  const candidates = [];

  // 1. Orphaned session rate — critical if high
  const orphanedCount = correlatedSessions.filter(s => s.isOrphaned).length;
  if (orphanedCount > 0 && correlatedSessions.length > 0) {
    const pct = Math.round((orphanedCount / correlatedSessions.length) * 100);
    if (pct >= 30) {
      candidates.push({
        priority: 1,
        type: 'warning',
        text: `${pct}% of sessions (${orphanedCount}/${correlatedSessions.length}) produced zero commits — likely wasted effort.`,
      });
    } else if (pct > 0) {
      candidates.push({
        priority: 3,
        type: 'info',
        text: `${pct}% of sessions (${orphanedCount}/${correlatedSessions.length}) produced zero commits.`,
      });
    }
  }

  // 2. Self-heal warning — critical behavioral signal
  if (autonomyMetrics && autonomyMetrics.totalBashCalls > 20 && autonomyMetrics.selfHealScore < 10) {
    candidates.push({
      priority: 1,
      type: 'warning',
      text: `Only ${autonomyMetrics.selfHealScore}% of ${autonomyMetrics.totalBashCalls} bash commands were tests or lints — low self-healing.`,
    });
  } else if (autonomyMetrics && autonomyMetrics.selfHealScore >= 40 && autonomyMetrics.totalBashCalls > 10) {
    candidates.push({
      priority: 3,
      type: 'success',
      text: `${autonomyMetrics.selfHealScore}% of bash commands were tests/lints — solid self-healing habit.`,
    });
  }

  // 3. Model cost efficiency — actionable comparison (real primary-model attribution)
  const modelFamilies = Object.entries(modelBreakdown).filter(([, d]) => d.commits > 0 && d.costPerCommit);
  if (modelFamilies.length > 1) {
    const sorted = [...modelFamilies].sort((a, b) => a[1].costPerCommit - b[1].costPerCommit);
    const best = sorted[0];
    const worst = sorted[sorted.length - 1];
    const ratio = worst[1].costPerCommit / best[1].costPerCommit;
    if (ratio >= 2) {
      candidates.push({
        priority: 2,
        type: 'info',
        text: `${capitalise(worst[0])} costs ${ratio.toFixed(1)}x more per commit than ${capitalise(best[0])}.`,
      });
    }
  }

  // 3b. Cache hit rate — cheap, high-ROI cost lever
  if (costControl && tokenAnalytics && tokenAnalytics.totalCacheReadTokens > 0) {
    const hit = tokenAnalytics.cacheHitRate;
    if (hit < costControl.benchmarks.cacheHitRatePct.warn && summary.totalCost > 1) {
      candidates.push({
        priority: 1,
        type: 'warning',
        text: `Cache hit rate is ${hit}% — well below the ~80% healthy range. Prompt caching is likely misconfigured, inflating cost.`,
      });
    } else if (hit < costControl.benchmarks.cacheHitRatePct.good && summary.totalCost > 1) {
      candidates.push({
        priority: 2,
        type: 'tip',
        text: `Cache hit rate is ${hit}% — pushing it toward 80%+ would cut input cost noticeably.`,
      });
    }
  }

  // 3c. Premium-model spend share — routing lever
  if (costControl && costControl.premiumSharePct >= costControl.benchmarks.premiumSharePct.warn && summary.totalCost > 5) {
    const save = costControl.estimatedRebalanceSavings;
    candidates.push({
      priority: 2,
      type: 'tip',
      text: `Opus drove ${costControl.premiumSharePct}% of spend${save > 0 ? ` — rerouting the Sonnet-eligible share could save ~$${save.toFixed(2)}` : ''}.`,
    });
  }

  // 4. Session length sweet spot — actionable tip
  const bucketEntries = Object.entries(sessionBuckets).filter(([, d]) => d.sessions > 0 && d.avgCostPerCommit !== null);
  if (bucketEntries.length > 1) {
    const sorted = [...bucketEntries].sort((a, b) => a[1].avgCostPerCommit - b[1].avgCostPerCommit);
    const best = sorted[0];
    const worst = sorted[sorted.length - 1];
    if (best[1].avgCostPerCommit && worst[1].avgCostPerCommit && worst[1].avgCostPerCommit >= best[1].avgCostPerCommit * 1.5) {
      candidates.push({
        priority: 2,
        type: 'tip',
        text: `Sessions of ${best[0]} messages are your sweet spot — $${best[1].avgCostPerCommit.toFixed(2)} per commit.`,
      });
    }
  }

  // 5. Cost concentration — useful 80/20 awareness
  if (summary.totalCost > 0 && correlatedSessions.length >= 10) {
    const sorted = [...correlatedSessions].sort((a, b) => b.cost.totalCost - a.cost.totalCost);
    const top20 = sorted.slice(0, Math.ceil(correlatedSessions.length * 0.2));
    const pct = Math.round((top20.reduce((s, c) => s + c.cost.totalCost, 0) / summary.totalCost) * 100);
    if (pct >= 70) {
      candidates.push({
        priority: 2,
        type: 'info',
        text: `Top 20% of sessions drove ${pct}% of total cost — a few heavy sessions dominate spend.`,
      });
    }
  }

  // 6. Main branch ratio — context-dependent
  if (summary.totalCommits >= 5) {
    const pct = summary.mainBranchPct;
    if (pct >= 70) {
      candidates.push({
        priority: 3,
        type: 'success',
        text: `${pct}% of AI-assisted commits landed on the default branch.`,
      });
    } else if (pct <= 15) {
      candidates.push({
        priority: 3,
        type: 'info',
        text: `Only ${pct}% of commits reached the default branch — most work lives on feature branches.`,
      });
    }
  }

  // 7. Commit latency — behavioral signal (unique, not on any card)
  const delays = [];
  for (const session of correlatedSessions) {
    if (!session.commits.length) continue;
    const sessionEnd = new Date(session.endTime).getTime();
    for (const c of session.commits) {
      const delay = c.timestampMs - sessionEnd;
      if (delay >= 0) delays.push(delay);
    }
  }
  if (delays.length >= 5) {
    const avgDelayMs = delays.reduce((s, d) => s + d, 0) / delays.length;
    const avgDelayMin = avgDelayMs / 60000;
    if (avgDelayMin < 5) {
      candidates.push({
        priority: 3,
        type: 'success',
        text: `Commits land fast — ${Math.max(1, Math.round(avgDelayMin))} min after session end on average.`,
      });
    } else if (avgDelayMin > 120) {
      candidates.push({
        priority: 3,
        type: 'info',
        text: `Commits land ~${(avgDelayMin / 60).toFixed(1)}h after sessions end — you sit on AI work before shipping.`,
      });
    }
  }

  // 9. Model token efficiency — distinct from cost ratio (tokens ≠ cost)
  const modelsForTokens = Object.entries(modelBreakdown).filter(([, d]) => d.tokensPerCommit);
  if (modelsForTokens.length > 1) {
    const sorted = [...modelsForTokens].sort((a, b) => a[1].tokensPerCommit - b[1].tokensPerCommit);
    const best = sorted[0], worst = sorted[sorted.length - 1];
    const ratio = worst[1].tokensPerCommit / best[1].tokensPerCommit;
    if (ratio >= 3) {
      candidates.push({
        priority: 3,
        type: 'info',
        text: `${capitalise(best[0])} uses ${formatBigNumber(best[1].tokensPerCommit)} tokens/commit vs ${formatBigNumber(worst[1].tokensPerCommit)} for ${capitalise(worst[0])}.`,
      });
    }
  }

  // Sort by priority (warnings first), cap at 8 to keep the section scannable
  return candidates
    .sort((a, b) => a.priority - b.priority)
    .slice(0, 8)
    .map(({ priority, ...rest }) => rest);
}

function capitalise(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Reframe dollar figures for the user's billing model. The API-equivalent cost (the
// market value of consumed tokens) is always computed; subscription plans replace the
// per-token bill with a flat monthly fee prorated across the window, and 'free' hides
// dollars entirely (tokens-only). The dashboard applies the actual display transform.
function buildPricing(plan, apiEquivalentCost, days) {
  const def = PLAN_PRICING[plan] || PLAN_PRICING.api;
  const monthlyUsd = def.monthlyUsd;
  const proratedPlanCost = monthlyUsd != null ? Math.round(monthlyUsd * (days / 30) * 100) / 100 : null;
  return {
    plan: PLAN_PRICING[plan] ? plan : 'api',
    label: def.label,
    monthlyUsd,
    proratedPlanCost,
    apiEquivalentCost: Math.round(apiEquivalentCost * 100) / 100,
    isSubscription: monthlyUsd != null && monthlyUsd > 0,
    showDollars: plan !== 'free',
  };
}

export function computeMetrics(correlatedSessions, organicCommits, commitsByRepo, days, plan = 'api') {
  // ---- Summary ----
  const totalCost = correlatedSessions.reduce((s, c) => s + c.cost.totalCost, 0);
  const totalSubagentCost = correlatedSessions.reduce((s, c) => s + (c.subagentCost || 0), 0);
  const totalActiveMinutes = correlatedSessions.reduce((s, c) => s + (c.activeMinutes || 0), 0);
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
  const orphanedSessionRate = totalSessions > 0 ? Math.round((orphanedCount / totalSessions) * 100) : 0;
  const efficiencyScore = computeEfficiencyScore(avgCost, lineSurvival.survivalRate, orphanedSessionRate, totalCommits);
  // Single consolidated grade — derived from the efficiency score, no separate scale.
  const overallGrade = efficiencyScore.letter;

  // ---- Daily timeline ----
  const dailyMap = new Map();
  const ensureDay = (date) => {
    if (!dailyMap.has(date)) {
      dailyMap.set(date, { date, cost: 0, sessions: 0, commits: 0, linesAdded: 0, linesDeleted: 0, netLines: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0 });
    }
    return dailyMap.get(date);
  };
  const toDateStr = (ts) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  for (const session of correlatedSessions) {
    const startDate = toDateStr(session.startTime);

    // Distribute cost and tokens across actual usage days via dailyUsage
    const usage = session.dailyUsage && Object.keys(session.dailyUsage).length > 0
      ? session.dailyUsage
      : { [startDate]: { inputTokens: session.totalInputTokens, outputTokens: session.totalOutputTokens, cacheReadTokens: session.cacheReadTokens, cacheCreationTokens: session.cacheCreationTokens, cost: session.cost.totalCost } };
    for (const [date, dayData] of Object.entries(usage)) {
      const day = ensureDay(date);
      day.cost += dayData.cost;
      day.inputTokens += dayData.inputTokens;
      day.outputTokens += dayData.outputTokens;
      day.cacheReadTokens += dayData.cacheReadTokens;
      day.totalTokens += dayData.inputTokens + dayData.outputTokens + dayData.cacheReadTokens + (dayData.cacheCreationTokens || 0);
    }

    // Session count attributed to each day it had activity
    for (const date of Object.keys(usage)) {
      ensureDay(date).sessions++;
    }

    // Commits attributed to their own timestamps
    for (const commit of session.commits) {
      const commitDate = toDateStr(commit.timestamp);
      const cDay = ensureDay(commitDate);
      cDay.commits++;
      cDay.linesAdded += commit.totalAdded || 0;
      cDay.linesDeleted += commit.totalDeleted || 0;
      cDay.netLines += (commit.totalAdded || 0) - (commit.totalDeleted || 0);
    }
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
  // Two distinct, both-real views per model family:
  //  • cost / tokens / subModels — true spend share across every session (a session
  //    using two models contributes to both families).
  //  • sessions / commits / costPerCommit — real PRIMARY-model attribution: a session's
  //    whole output is credited to its dominant model. This replaces the old approach
  //    that split single commits into fractional per-model pieces by token share.
  const modelBreakdown = {};
  const ensureFamily = (family) => {
    if (!modelBreakdown[family]) {
      modelBreakdown[family] = {
        cost: 0, tokens: 0, subModels: {},
        sessions: 0, commits: 0, linesAdded: 0,
        primaryCost: 0, primaryTokens: 0,
        costPerCommit: null, tokensPerCommit: null,
      };
    }
    return modelBreakdown[family];
  };

  for (const session of correlatedSessions) {
    for (const [model, data] of Object.entries(session.modelBreakdown)) {
      const fam = ensureFamily(getModelFamily(model) || 'unknown');
      fam.cost += data.cost;
      fam.tokens += data.tokens;
      if (!fam.subModels[model]) fam.subModels[model] = { cost: 0, tokens: 0 };
      fam.subModels[model].cost += data.cost;
      fam.subModels[model].tokens += data.tokens;
    }
  }

  for (const session of correlatedSessions) {
    const fam = ensureFamily(getModelFamily(session.model) || 'unknown');
    fam.sessions += 1;
    fam.commits += session.commitCount;
    fam.linesAdded += session.linesAdded;
    fam.primaryCost += session.cost.totalCost;
    fam.primaryTokens += Object.values(session.modelBreakdown).reduce((s, d) => s + d.tokens, 0);
  }

  for (const data of Object.values(modelBreakdown)) {
    data.costPerCommit = data.commits > 0 ? data.primaryCost / data.commits : null;
    data.tokensPerCommit = data.commits > 0 ? Math.round(data.primaryTokens / data.commits) : null;
    data.subModels = Object.fromEntries(
      Object.entries(data.subModels).sort(([, a], [, b]) => b.cost - a.cost)
    );
  }

  // Premium-model spend share (cost-control lever: Opus work that Sonnet could do).
  const totalModelCost = Object.values(modelBreakdown).reduce((s, d) => s + d.cost, 0);
  const premiumCost = Object.entries(modelBreakdown)
    .filter(([fam]) => PREMIUM_FAMILIES.has(fam))
    .reduce((s, [, d]) => s + d.cost, 0);
  const premiumSharePct = totalModelCost > 0 ? Math.round((premiumCost / totalModelCost) * 100) : 0;
  // Rough rebalance estimate: a Sonnet-eligible slice of premium spend costs ~0.6x on
  // Sonnet ($3/$15 vs $5/$25), so the avoidable amount on the premium overage is ~0.4x.
  const premiumOverage = Math.max(0, premiumSharePct - BENCHMARKS.premiumSharePct.good) / 100 * totalModelCost;
  const estimatedRebalanceSavings = Math.round(premiumOverage * 0.4 * 100) / 100;

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

  // ---- Heatmap: commits by (day-of-week × hour), cost by day-of-week ----
  // Commits carry a real hour-of-day (their timestamp). Cost is only known per
  // calendar day (via dailyUsage), so it is bucketed by day-of-week only — no fake
  // hour precision.
  const heatmap = Array.from({ length: 7 }, () => Array(24).fill(0));
  const heatmapCostByDow = Array(7).fill(0);
  for (const session of correlatedSessions) {
    // Place each commit at its actual timestamp, not the session start
    for (const commit of session.commits) {
      const d = new Date(commit.timestamp);
      const dayOfWeek = d.getDay(); // 0=Sun
      const hour = d.getHours();
      heatmap[dayOfWeek][hour]++;
    }
    // Distribute cost across actual usage days via dailyUsage
    const usage = session.dailyUsage && Object.keys(session.dailyUsage).length > 0
      ? session.dailyUsage
      : { [toDateStr(session.startTime)]: { cost: session.cost.totalCost } };
    for (const [dateStr, dayData] of Object.entries(usage)) {
      const dd = new Date(dateStr + 'T12:00:00'); // noon local to get correct day-of-week
      heatmapCostByDow[dd.getDay()] += dayData.cost;
    }
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

  // ---- Cost breakdown by time period ----
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const startOfWeek = new Date(now); startOfWeek.setDate(now.getDate() - now.getDay());
  startOfWeek.setHours(0, 0, 0, 0);
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const mkPeriod = () => ({ cost: 0, sessions: 0, commits: 0, tokens: 0 });
  const costByPeriod = { today: mkPeriod(), week: mkPeriod(), month: mkPeriod(), allTime: mkPeriod() };
  for (const session of correlatedSessions) {
    const startDateStr = toDateStr(session.startTime);

    // Distribute cost and tokens across actual usage days
    const usage = session.dailyUsage && Object.keys(session.dailyUsage).length > 0
      ? session.dailyUsage
      : { [startDateStr]: { inputTokens: session.totalInputTokens, outputTokens: session.totalOutputTokens, cacheReadTokens: session.cacheReadTokens, cacheCreationTokens: session.cacheCreationTokens, cost: session.cost.totalCost } };
    for (const [dateStr, dayData] of Object.entries(usage)) {
      const dDate = new Date(dateStr + 'T12:00:00');
      const dTok = dayData.inputTokens + dayData.outputTokens + dayData.cacheReadTokens + (dayData.cacheCreationTokens || 0);
      costByPeriod.allTime.cost += dayData.cost; costByPeriod.allTime.tokens += dTok;
      if (dDate >= startOfMonth) { costByPeriod.month.cost += dayData.cost; costByPeriod.month.tokens += dTok; }
      if (dDate >= startOfWeek) { costByPeriod.week.cost += dayData.cost; costByPeriod.week.tokens += dTok; }
      if (dateStr === todayStr) { costByPeriod.today.cost += dayData.cost; costByPeriod.today.tokens += dTok; }
    }

    // Sessions count if they had any activity in the period (via dailyUsage dates)
    const usageDates = Object.keys(usage);
    const hasActivityToday = usageDates.includes(todayStr);
    const hasActivityThisWeek = usageDates.some(d => new Date(d + 'T12:00:00') >= startOfWeek);
    const hasActivityThisMonth = usageDates.some(d => new Date(d + 'T12:00:00') >= startOfMonth);
    costByPeriod.allTime.sessions++;
    if (hasActivityThisMonth) costByPeriod.month.sessions++;
    if (hasActivityThisWeek) costByPeriod.week.sessions++;
    if (hasActivityToday) costByPeriod.today.sessions++;

    // Commits count by their actual commit date, not session start date
    for (const commit of (session.commits || [])) {
      const commitDateStr = toDateStr(commit.timestamp);
      const commitDate = new Date(commitDateStr + 'T12:00:00');
      costByPeriod.allTime.commits++;
      if (commitDate >= startOfMonth) costByPeriod.month.commits++;
      if (commitDate >= startOfWeek) costByPeriod.week.commits++;
      if (commitDateStr === todayStr) costByPeriod.today.commits++;
    }
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
    // Durability-adjusted: cost per line that actually survived (signature outcome metric).
    costPerSurvivingLine: lineSurvival.surviving > 0 ? totalCost / lineSurvival.surviving : null,
    totalActiveMinutes: Math.round(totalActiveMinutes),
    costPerActiveHour: totalActiveMinutes > 0 ? totalCost / (totalActiveMinutes / 60) : null,
    totalInputTokens,
    totalOutputTokens,
    orphanedSessionRate,
    lineSurvivalRate: lineSurvival.survivalRate,
    overallGrade,
    efficiencyScore,
    totalCommitsOnMain,
    mainBranchPct: totalCommits > 0 ? Math.round((totalCommitsOnMain / totalCommits) * 100) : 0,
    organicCommitCount: organicCommits.length,
    pricing: buildPricing(plan, totalCost, days),
    bestDay,
    worstDay,
    costByPeriod,
  };

  // ---- Token analytics ----
  const tokenAnalytics = computeTokenAnalytics(correlatedSessions, lineSurvival, totalCommits, totalLinesAdded, modelBreakdown);

  // ---- Cost-control levers (cache, model routing, delegated spend) ----
  const costControl = {
    cacheHitRate: tokenAnalytics.cacheHitRate,
    cacheSavingsDollars: Math.round(tokenAnalytics.cacheSavingsDollars * 100) / 100,
    premiumSharePct,
    premiumCost: Math.round(premiumCost * 100) / 100,
    estimatedRebalanceSavings,
    subagentCost: Math.round(totalSubagentCost * 100) / 100,
    subagentSharePct: totalCost > 0 ? Math.round((totalSubagentCost / totalCost) * 100) : 0,
    benchmarks: BENCHMARKS,
  };

  // ---- Autonomy metrics ----
  const autonomyMetrics = computeAutonomyMetrics(correlatedSessions);

  // Add grades + autonomy to sessions
  const autonomyBySession = new Map(autonomyMetrics.perSession.map(a => [a.sessionId, a]));
  const sessionsWithGrades = correlatedSessions.map(s => {
    const a = autonomyBySession.get(s.sessionId);
    return {
      ...s,
      grade: computeSessionGrade(s),
      autopilotRatio: a?.autopilotRatio ?? 0,
      selfHealScore: a?.selfHealScore ?? 0,
      commitVelocity: a?.commitVelocity ?? null,
    };
  });

  const insights = generateInsights(summary, correlatedSessions, modelBreakdown, sessionBuckets, tokenAnalytics, autonomyMetrics, costControl);

  const weeklyNarrative = buildWeeklyNarrative(correlatedSessions, autonomyMetrics);

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
    costControl,
    autonomyMetrics,
    insights,
    daily,
    projects,
    sessions: sessionsWithGrades,
    modelBreakdown,
    toolBreakdown,
    sessionBuckets,
    lineSurvival,
    heatmap: { commits: heatmap, costByDay: heatmapCostByDow },
    weeklyNarrative,
    organicCommits,
  };
}
