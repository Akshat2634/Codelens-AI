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

function buildWeeklyNarrative(correlatedSessions, daily, autonomyMetrics) {
  if (!correlatedSessions.length) return null;

  const now = Date.now();
  const WEEK_MS = 7 * 24 * 3600 * 1000;
  const thisStart = now - WEEK_MS;
  const lastStart = now - 2 * WEEK_MS;

  const aggregate = (startMs, endMs) => {
    const ss = correlatedSessions.filter(s => {
      const t = new Date(s.startTime).getTime();
      return t >= startMs && t < endMs;
    });
    const cost = ss.reduce((a, b) => a + b.cost.totalCost, 0);
    const commits = ss.reduce((a, b) => a + b.commitCount, 0);
    const linesAdded = ss.reduce((a, b) => a + b.linesAdded, 0);
    const tokens = ss.reduce((a, b) => a + b.totalInputTokens + b.totalOutputTokens + b.cacheReadTokens + b.cacheCreationTokens, 0);
    const msgUser = ss.reduce((a, b) => a + b.userMessageCount, 0);
    const msgAssistant = ss.reduce((a, b) => a + b.assistantMessageCount, 0);
    const autopilot = msgUser > 0 ? msgAssistant / msgUser : 0;
    const costPerCommit = commits > 0 ? cost / commits : null;

    const modelCost = {};
    const modelLines = {};
    for (const s of ss) {
      const sessionTokens = Object.values(s.modelBreakdown).reduce((sum, d) => sum + d.tokens, 0);
      for (const [m, data] of Object.entries(s.modelBreakdown)) {
        const fam = getModelFamily(m) || 'unknown';
        modelCost[fam] = (modelCost[fam] || 0) + data.cost;
        const share = sessionTokens > 0 ? data.tokens / sessionTokens : 0;
        modelLines[fam] = (modelLines[fam] || 0) + s.linesAdded * share;
      }
    }
    const dominantModel = Object.entries(modelCost).sort((a, b) => b[1] - a[1])[0] || null;

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

  // Best day inside the week
  const dailyInWeek = daily.filter(d => {
    const t = new Date(d.date + 'T12:00:00').getTime();
    return t >= thisStart && t < now;
  });
  const bestDay = dailyInWeek.filter(d => d.commits > 0).sort((a, b) => b.commits - a.commits)[0];
  if (bestDay) {
    const dn = new Date(bestDay.date + 'T12:00:00');
    const dayLabel = dn.toLocaleDateString(undefined, { weekday: 'long' });
    bullets.push(`${dayLabel} was your most productive day — ${bestDay.commits} commit${bestDay.commits === 1 ? '' : 's'} for $${bestDay.cost.toFixed(2)}.`);
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
const KNOWN_TOOLS = [
  'Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'LS',
  'WebFetch', 'WebSearch', 'NotebookEdit', 'NotebookRead', 'TodoWrite', 'Agent',
];
const TOTAL_AVAILABLE_TOOLS = KNOWN_TOOLS.length; // 14

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

    const uniqueTools = Object.keys(s.toolCalls).length;
    const toolbeltCoverage = Math.round((uniqueTools / TOTAL_AVAILABLE_TOOLS) * 100);

    const totalToolCalls = Object.values(s.toolCalls).reduce((sum, c) => sum + c, 0);
    const commitVelocity = s.commitCount > 0 ? Math.round(totalToolCalls / s.commitCount) : null;

    return { sessionId: s.sessionId, autopilotRatio, selfHealScore, toolbeltCoverage, commitVelocity };
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

  const toolbeltCoverage = perSession.length > 0
    ? Math.round(perSession.reduce((s, a) => s + a.toolbeltCoverage, 0) / perSession.length)
    : 0;

  const withCommits = perSession.filter(a => a.commitVelocity !== null);
  const commitVelocity = withCommits.length > 0
    ? Math.round(withCommits.reduce((s, a) => s + a.commitVelocity, 0) / withCommits.length)
    : null;

  // Composite score (0-100): clamp and weight each component
  const autopilotScore = Math.round(Math.min(autopilotRatio / 5, 1) * 100);
  const selfHealWeighted = selfHealScore;
  const toolbeltWeighted = toolbeltCoverage;
  const velocityScore = commitVelocity !== null
    ? Math.round(Math.max(0, Math.min(1, 1 - (commitVelocity / 100))) * 100)
    : 50; // neutral when no commits

  const overallScore = Math.round(
    autopilotScore * 0.25 +
    selfHealWeighted * 0.30 +
    toolbeltWeighted * 0.20 +
    velocityScore * 0.25
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
    toolbeltCoverage,
    commitVelocity,
    totalBashCalls: totalBash,
    totalVerificationCalls: totalVerif,
    topVerificationCommands,
    perSession,
    breakdown: { autopilotScore, selfHealWeighted, toolbeltWeighted, velocityScore },
  };
}

function computeEfficiencyGrade(costPerCommit, survivalRate) {
  // Grade based on cost per commit (more meaningful than raw token count)
  if (costPerCommit <= 2 && survivalRate >= 90) return 'A';
  if (costPerCommit <= 5 && survivalRate >= 75) return 'B';
  if (costPerCommit <= 15 && survivalRate >= 50) return 'C';
  if (costPerCommit <= 40 && survivalRate >= 25) return 'D';
  return 'F';
}

function computeEfficiencyScore(costPerCommit, survivalRate, orphanedRate, totalCommits) {
  if (totalCommits === 0) {
    return {
      score: 0, tier: 'Getting Started', letter: 'F',
      explanation: 'No commits matched to sessions yet — this is normal for exploratory work.',
      tip: 'Commits are matched by file overlap with Claude-edited files.',
    };
  }

  // Score: 50 pts from cost efficiency (log scale) + 50 pts from survival rate
  let costScore;
  if (costPerCommit <= 2) costScore = 50;
  else if (costPerCommit >= 50) costScore = 0;
  else costScore = Math.max(0, 50 * (1 - Math.log(costPerCommit / 2) / Math.log(25)));
  const survivalScore = Math.min(survivalRate, 100) / 100 * 50;
  const score = Math.round(costScore + survivalScore);

  const tier = score >= 80 ? 'Excellent' : score >= 60 ? 'Solid' : score >= 40 ? 'Developing' : score >= 20 ? 'Early' : 'Getting Started';
  const letter = score >= 80 ? 'A' : score >= 60 ? 'B' : score >= 40 ? 'C' : score >= 20 ? 'D' : 'F';

  // Build explanation from actual metrics
  const costAdj = costPerCommit <= 2 ? 'excellent' : costPerCommit <= 5 ? 'good' : costPerCommit <= 15 ? 'moderate' : 'high';
  const explanation = `$${costPerCommit.toFixed(2)}/commit (${costAdj}) · ${Math.round(survivalRate)}% code survival`;

  // Actionable tip based on weakest metric
  let tip;
  if (costScore < survivalScore) {
    tip = 'Try shorter, focused sessions to reduce cost per commit.';
  } else if (survivalRate < 50) {
    tip = 'Review AI-generated code before committing to improve survival rate.';
  } else if (orphanedRate > 40) {
    tip = `${orphanedRate}% of sessions had no commits — some may be exploratory, which is fine.`;
  } else {
    tip = 'Keep it up — your efficiency is on track.';
  }

  return { score, tier, letter, explanation, tip };
}

function computeSessionGrade(session) {
  if (session.commitCount === 0) return 'F';
  const costPerCommit = session.cost.totalCost / session.commitCount;
  // Use 80 as a default survival (we don't have per-session survival)
  return computeEfficiencyGrade(costPerCommit, 80);
}

function generateInsights(summary, correlatedSessions, modelBreakdown, sessionBuckets, tokenAnalytics, autonomyMetrics) {
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

  // 3. Model cost efficiency — actionable comparison
  const modelFamilies = Object.entries(modelBreakdown).filter(([, d]) => d.sessions > 0 && d.avgCostPerCommit);
  if (modelFamilies.length > 1) {
    const sorted = [...modelFamilies].sort((a, b) => a[1].avgCostPerCommit - b[1].avgCostPerCommit);
    const best = sorted[0];
    const worst = sorted[sorted.length - 1];
    const ratio = worst[1].avgCostPerCommit / best[1].avgCostPerCommit;
    if (ratio >= 2) {
      candidates.push({
        priority: 2,
        type: 'info',
        text: `${capitalise(worst[0])} costs ${ratio.toFixed(1)}x more per commit than ${capitalise(best[0])}.`,
      });
    }
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

  // 8. Toolbelt coverage — actionable for under-utilized setups
  if (autonomyMetrics && autonomyMetrics.toolbeltCoverage < 30 && correlatedSessions.length >= 5) {
    const used = Math.round(autonomyMetrics.toolbeltCoverage * TOTAL_AVAILABLE_TOOLS / 100);
    candidates.push({
      priority: 2,
      type: 'tip',
      text: `Your agent used ${used} of ${TOTAL_AVAILABLE_TOOLS} available tools — low toolbelt coverage.`,
    });
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
  const orphanedSessionRate = totalSessions > 0 ? Math.round((orphanedCount / totalSessions) * 100) : 0;
  const overallGrade = totalCommits > 0
    ? computeEfficiencyGrade(avgCost, lineSurvival.survivalRate)
    : 'F';
  const efficiencyScore = computeEfficiencyScore(avgCost, lineSurvival.survivalRate, orphanedSessionRate, totalCommits);

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
    // Distribute cost across actual usage days via dailyUsage
    const usage = session.dailyUsage && Object.keys(session.dailyUsage).length > 0
      ? session.dailyUsage
      : { [toDateStr(session.startTime)]: { cost: session.cost.totalCost } };
    for (const [dateStr, dayData] of Object.entries(usage)) {
      const dd = new Date(dateStr + 'T12:00:00'); // noon local to get correct day-of-week
      heatmapCost[dd.getDay()][12] += dayData.cost;
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
    totalInputTokens,
    totalOutputTokens,
    orphanedSessionRate,
    lineSurvivalRate: lineSurvival.survivalRate,
    overallGrade,
    efficiencyScore,
    totalCommitsOnMain,
    mainBranchPct: totalCommits > 0 ? Math.round((totalCommitsOnMain / totalCommits) * 100) : 0,
    organicCommitCount: organicCommits.length,
    bestDay,
    worstDay,
    costByPeriod,
  };

  // ---- Token analytics ----
  const tokenAnalytics = computeTokenAnalytics(correlatedSessions, lineSurvival, totalCommits, totalLinesAdded, modelBreakdown);

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
      toolbeltCoverage: a?.toolbeltCoverage ?? 0,
      commitVelocity: a?.commitVelocity ?? null,
    };
  });

  const insights = generateInsights(summary, correlatedSessions, modelBreakdown, sessionBuckets, tokenAnalytics, autonomyMetrics);

  const weeklyNarrative = buildWeeklyNarrative(correlatedSessions, daily, autonomyMetrics);

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
    autonomyMetrics,
    insights,
    daily,
    projects,
    sessions: sessionsWithGrades,
    modelBreakdown,
    toolBreakdown,
    sessionBuckets,
    lineSurvival,
    heatmap: { commits: heatmap, cost: heatmapCost },
    weeklyNarrative,
    organicCommits,
  };
}
