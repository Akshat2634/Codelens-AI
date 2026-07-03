import { getModelFamily as getClaudeModelFamily } from './claude-parser.js';
import { getCodexModelFamily } from './codex-parser.js';
import { commitLinesForSession } from './correlator.js';

// Family resolution across agent sources: Claude names first (opus/sonnet/
// haiku/fable), then OpenAI Codex names (gpt-5-codex/gpt-5/o-series/...).
function getModelFamily(modelName) {
  return getClaudeModelFamily(modelName) || getCodexModelFamily(modelName);
}

const CHURN_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

function formatBigNumber(n) {
  // Thresholds at the display rollover so 999.96M reads 1.0B, not 1000.0M
  if (n >= 999.95e6) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 999.95e3) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 999.5) return (n / 1e3).toFixed(1) + 'K';
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
  // Output per input token the model actually processed (fresh input + cache
  // reads). Excluding cache reads inflates this badly under heavy prompt caching.
  const effectiveInput = totalInputTokens + totalCacheReadTokens;
  const outputInputRatio = effectiveInput > 0
    ? Math.round((totalOutputTokens / effectiveInput) * 100) / 100 : 0;

  // Cache efficiency. Cache-creation tokens are also prompt tokens processed
  // fresh (at a write premium), so they belong in the denominator — otherwise
  // "share of input served from cache" is overstated under heavy caching.
  const totalRawInput = totalInputTokens + totalCacheReadTokens + totalCacheCreationTokens;
  const cacheHitRate = totalRawInput > 0
    ? Math.round((totalCacheReadTokens / totalRawInput) * 100) : 0;
  // Avoided cost of cache reads, computed per pricing tier by the parser
  // (a flat 9x of cacheReadCost misprices tiers like haiku-3 whose cache-read
  // rate isn't exactly 0.1x input). Fallback for sessions parsed before the
  // field existed: the 0.1x approximation.
  const cacheSavingsDollars = correlatedSessions.reduce(
    (s, c) => s + (c.cacheSavingsDollars ?? c.cost.cacheReadCost * 9), 0);

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

  // Everything week-scoped shares one boundary rule: the calendar day (taken
  // at noon to avoid TZ edge skew) must fall inside [startMs, endMs). Cost can
  // only be bucketed by day (dailyUsage), so commits use the same day rule —
  // exact commit timestamps against day-bucketed cost would count a boundary
  // commit in a week that excludes its spend. This is also costByPeriod's
  // rule, so "this week" is one population everywhere it's displayed.
  const dayKey = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const dayInRange = (dateStr, startMs, endMs) => {
    const t = Date.parse(dateStr + 'T12:00:00');
    return t >= startMs && t < endMs;
  };
  const commitInRange = (c, startMs, endMs) => dayInRange(dayKey(c.timestampMs), startMs, endMs);

  // The live week's end extends to end-of-today: day buckets compare at noon,
  // so an upper bound of `now` would silently drop all of today's usage and
  // commits whenever the dashboard runs before noon. Interior boundaries
  // (this week vs last week) stay exact.
  const endOfToday = Date.parse(dayKey(now) + 'T23:59:59.999');

  // Cost and tokens bucket by ACTUAL usage day (dailyUsage) — a whole-session
  // bucket by start time would divide last week's spend by this week's commits
  // when a session straddles the boundary. Sessions count as active if they
  // had any usage day inside the window.
  const windowUsage = (s, startMs, endMs) => {
    const entries = Object.entries(s.dailyUsage || {});
    if (entries.length === 0) {
      // No per-day data — fall back to whole-session bucketing by start time
      const t = new Date(s.startTime).getTime();
      return t >= startMs && t < endMs
        ? { cost: s.cost.totalCost, tokens: s.totalInputTokens + s.totalOutputTokens + s.cacheReadTokens + s.cacheCreationTokens, active: true }
        : { cost: 0, tokens: 0, active: false };
    }
    let cost = 0;
    let tokens = 0;
    let active = false;
    for (const [dateStr, day] of entries) {
      if (!dayInRange(dateStr, startMs, endMs)) continue;
      active = true;
      cost += day.cost;
      tokens += day.inputTokens + day.outputTokens + day.cacheReadTokens + (day.cacheCreationTokens || 0);
    }
    return { cost, tokens, active };
  };

  const aggregate = (startMs, endMs) => {
    const perSession = correlatedSessions.map(s => ({ s, w: windowUsage(s, startMs, endMs) }));
    const ss = perSession.filter(x => x.w.active).map(x => x.s);
    const cost = perSession.reduce((a, x) => a + x.w.cost, 0);
    const tokens = perSession.reduce((a, x) => a + x.w.tokens, 0);
    // Message counts are whole-session (never day-bucketed), so this ratio
    // describes the sessions ACTIVE this week rather than strictly this
    // week's messages — the bullet wording below says exactly that.
    const msgUser = ss.reduce((a, b) => a + b.userMessageCount, 0);
    const msgAssistant = ss.reduce((a, b) => a + b.assistantMessageCount, 0);
    const autopilot = msgUser > 0 ? msgAssistant / msgUser : 0;

    // Per-family spend and token share, from the in-window days' per-model
    // splits (dailyUsage.byModel) — whole-session family numbers would credit
    // this week's spend and lines to models used in other weeks when a session
    // straddles the boundary. Sessions without per-day splits fall back to
    // whole-session shares scaled to their in-window cost.
    const modelCost = {};
    const famTokensBySession = new Map();
    for (const { s, w } of perSession) {
      if (!w.active) continue;
      const famCost = {};
      const famTokens = {};
      let covered = false;
      for (const [dateStr, day] of Object.entries(s.dailyUsage || {})) {
        if (!day.byModel || !dayInRange(dateStr, startMs, endMs)) continue;
        covered = true;
        for (const [m, v] of Object.entries(day.byModel)) {
          const fam = getModelFamily(m) || 'unknown';
          famCost[fam] = (famCost[fam] || 0) + v.cost;
          famTokens[fam] = (famTokens[fam] || 0) + v.tokens;
        }
      }
      if (!covered) {
        const scale = s.cost.totalCost > 0 ? w.cost / s.cost.totalCost : 0;
        for (const [m, data] of Object.entries(s.modelBreakdown)) {
          const fam = getModelFamily(m) || 'unknown';
          famCost[fam] = (famCost[fam] || 0) + data.cost * scale;
          famTokens[fam] = (famTokens[fam] || 0) + data.tokens;
        }
      }
      for (const [fam, c] of Object.entries(famCost)) modelCost[fam] = (modelCost[fam] || 0) + c;
      famTokensBySession.set(s, famTokens);
    }
    const dominantModel = Object.entries(modelCost).sort((a, b) => b[1] - a[1])[0] || null;

    // Output metrics (commits, lines, lines-by-model) bucket by commit day.
    // Lines split across families by each session's IN-WINDOW token share.
    let commits = 0;
    let linesAdded = 0;
    const modelLines = {};
    for (const { s } of perSession) {
      const famTokens = famTokensBySession.get(s);
      const famTotal = famTokens ? Object.values(famTokens).reduce((a, b) => a + b, 0) : 0;
      for (const c of (s.commits || [])) {
        if (!commitInRange(c, startMs, endMs)) continue;
        commits++;
        const cLines = commitLinesAdded(s, c);
        linesAdded += cLines;
        if (famTotal > 0) {
          for (const [fam, tk] of Object.entries(famTokens)) {
            modelLines[fam] = (modelLines[fam] || 0) + cLines * (tk / famTotal);
          }
        }
      }
    }

    const costPerCommit = commits > 0 ? cost / commits : null;

    return { sessions: ss.length, cost, commits, linesAdded, tokens, autopilot, costPerCommit, dominantModel, modelCost, modelLines };
  };

  const thisWeek = aggregate(thisStart, endOfToday);
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
      // "First week" only when nothing at all precedes this week's start — an
      // agent used intermittently for months just has a quiet prior week.
      const earliestActivityMs = Math.min(...correlatedSessions.map(s => {
        const firstDay = Object.keys(s.dailyUsage || {}).sort()[0];
        return firstDay ? Date.parse(firstDay + 'T12:00:00') : new Date(s.startTime).getTime();
      }));
      headline += earliestActivityMs >= thisStart
        ? ` — first week of measured activity.`
        : ` — no activity last week to compare.`;
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
    bullets.push(`Autopilot ratio: ${thisWeek.autopilot.toFixed(1)}x across sessions active this week — ${thisWeek.autopilot.toFixed(1)} agent actions per prompt.`);
  }

  // Best day inside the week — same day rule as everything above. Cost is
  // attributed proportionally from each session's IN-WEEK spend (not its
  // whole-window cost, which could exceed the Weekly Spend shown right above):
  // each in-week commit inherits weekCost / weekCommitCount from its session.
  const commitsByDay = {};
  for (const s of correlatedSessions) {
    const weekCommits = (s.commits || []).filter(c => commitInRange(c, thisStart, endOfToday));
    if (weekCommits.length === 0) continue;
    const perCommitCost = windowUsage(s, thisStart, endOfToday).cost / weekCommits.length;
    for (const c of weekCommits) {
      const key = dayKey(c.timestampMs);
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

function computeLineSurvival(correlatedSessions) {
  let totalAdded = 0;
  let totalChurned = 0;

  // Build a per-file edit timeline from AI-correlated commits ONLY, counting just
  // the lines in files the matched session actually wrote (overlap). This makes
  // survival an AI-quality signal (not "all of the user's code") and makes its
  // totalAdded reconcile exactly with summary.totalLinesAdded.
  const fileTimeline = new Map();
  for (const session of correlatedSessions) {
    const sessionFiles = new Set(session.filesWritten || []);
    const chatOnly = sessionFiles.size === 0;
    for (const commit of (session.commits || [])) {
      for (const file of commit.files) {
        if (!chatOnly && !sessionFiles.has(file.path)) continue;
        // Key by repo + path: two repos can both have e.g. src/index.js, and
        // merging their timelines would count cross-repo edits as churn.
        const key = `${session.repoPath || ''}|${file.path}`;
        if (!fileTimeline.has(key)) fileTimeline.set(key, []);
        fileTimeline.get(key).push({
          timestampMs: commit.timestampMs,
          added: file.added,
          deleted: file.deleted,
        });
      }
    }
  }

  // Churn accounting per file. Walk edits in order keeping a LIFO stack of
  // still-live additions; each deletion consumes the most-recent additions, and
  // only deletions that land within CHURN_WINDOW_MS of an addition count as churn
  // (a deletion after the window is a legitimate later change, not rework). This
  // catches multi-edit rework that a naive next-edit-only comparison misses.
  const nowMs = Date.now();
  let maturing = 0; // lines too young to have been observable for a full window
  for (const entries of fileTimeline.values()) {
    entries.sort((a, b) => a.timestampMs - b.timestampMs);
    const live = []; // { ts, n } additions not yet deleted
    for (const e of entries) {
      totalAdded += e.added;
      let toDelete = e.deleted;
      while (toDelete > 0 && live.length > 0) {
        const block = live[live.length - 1];
        const take = Math.min(block.n, toDelete);
        if (e.timestampMs - block.ts <= CHURN_WINDOW_MS) totalChurned += take;
        block.n -= take;
        toDelete -= take;
        if (block.n === 0) live.pop();
      }
      if (e.added > 0) live.push({ ts: e.timestampMs, n: e.added });
    }
    // Lines still live but younger than the window can't be judged yet — exclude
    // them from the rate (right-censoring) so recent work doesn't inflate survival.
    for (const block of live) {
      if (nowMs - block.ts < CHURN_WINDOW_MS) maturing += block.n;
    }
  }

  const surviving = totalAdded - totalChurned; // raw lines that survived the window
  const observed = totalAdded - maturing;      // lines old enough to judge
  const survived = surviving - maturing;       // matured lines that weren't churned
  // null when nothing is old enough to judge — a fabricated 100% would feed the
  // efficiency score and grade with evidence that doesn't exist yet. Otherwise
  // rounded to the nearest 5% to avoid false precision.
  const survivalRate = observed > 0 ? Math.round((survived / observed) * 100 / 5) * 5 : null;

  return { totalAdded, totalChurned, surviving, maturing, survivalRate };
}

// ---- Autonomy metrics ----
const KNOWN_TOOLS = [
  'Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'LS',
  'WebFetch', 'WebSearch', 'NotebookEdit', 'NotebookRead', 'TodoWrite', 'Agent',
];
const TOTAL_AVAILABLE_TOOLS = KNOWN_TOOLS.length; // 14
// Codex CLI ships a much smaller toolbelt — measuring its sessions against the
// Claude vocabulary structurally reads "narrow tool usage" for every session.
const KNOWN_CODEX_TOOLS = [
  'shell', 'apply_patch', 'update_plan', 'web_search', 'write_stdin',
  'read_thread_terminal', 'request_user_input', 'view_image', 'tool_search',
];
// The shell tool's name has drifted across Codex CLI versions; collapse the
// aliases so one logical tool can't count several times in the numerator.
const CODEX_SHELL_ALIASES = new Set(['exec_command', 'container.exec', 'local_shell_call']);

function computeAutonomyGrade(score) {
  if (score >= 80) return 'A';
  if (score >= 60) return 'B';
  if (score >= 40) return 'C';
  if (score >= 20) return 'D';
  return 'F';
}

function computeAutonomyMetrics(correlatedSessions, cutoffMs = 0) {
  const perSession = correlatedSessions.map(s => {
    const autopilotRatio = s.userMessageCount > 0
      ? Math.round((s.assistantMessageCount / s.userMessageCount) * 100) / 100
      : 0;

    // Self-heal denominator excludes read-only shell calls (sed/rg/ls) —
    // Codex routes file reading through the shell, which would structurally
    // deflate the score. `|| 0` keeps sessions cached before the field existed.
    const attemptedBashCalls = Math.max(1, (s.totalBashCalls || 0) - (s.readOnlyBashCalls || 0));
    const selfHealScore = s.totalBashCalls > 0
      ? Math.round(Math.min(1, s.verificationBashCalls / attemptedBashCalls) * 100)
      : 0;

    const isCodex = s.source === 'codex';
    const uniqueTools = isCodex
      ? new Set(Object.keys(s.toolCalls).map(t => (CODEX_SHELL_ALIASES.has(t) ? 'shell' : t))).size
      : Object.keys(s.toolCalls).length;
    const knownToolCount = isCodex ? KNOWN_CODEX_TOOLS.length : TOTAL_AVAILABLE_TOOLS;
    // Descriptor only (not scored): clamp at 100 since sessions can use more
    // distinct tools (MCP/custom/Task) than the fixed known-tool denominator.
    const toolbeltCoverage = Math.min(100, Math.round((uniqueTools / knownToolCount) * 100));

    const totalToolCalls = Object.values(s.toolCalls).reduce((sum, c) => sum + c, 0);
    // Tool calls are whole-session while commitCount is window-clipped — for a
    // session that started before the window the ratio would divide steps it
    // took weeks ago by only its in-window commits, so velocity is reported
    // only for sessions that started inside the window.
    const straddlesWindow = cutoffMs > 0 && s.startTime && new Date(s.startTime).getTime() < cutoffMs;
    const commitVelocity = !straddlesWindow && s.commitCount > 0 ? Math.round(totalToolCalls / s.commitCount) : null;

    return { sessionId: s.sessionId, autopilotRatio, selfHealScore, toolbeltCoverage, commitVelocity };
  });

  // Aggregates
  const totalUser = correlatedSessions.reduce((s, c) => s + c.userMessageCount, 0);
  const totalAssistant = correlatedSessions.reduce((s, c) => s + c.assistantMessageCount, 0);
  const autopilotRatio = totalUser > 0
    ? Math.round((totalAssistant / totalUser) * 100) / 100
    : 0;

  const totalBash = correlatedSessions.reduce((s, c) => s + (c.totalBashCalls || 0), 0);
  const totalReadOnly = correlatedSessions.reduce((s, c) => s + (c.readOnlyBashCalls || 0), 0);
  const totalVerif = correlatedSessions.reduce((s, c) => s + (c.verificationBashCalls || 0), 0);
  const selfHealScore = totalBash > 0
    ? Math.round(Math.min(1, totalVerif / Math.max(1, totalBash - totalReadOnly)) * 100)
    : 0;

  const toolbeltCoverage = perSession.length > 0
    ? Math.min(100, Math.round(perSession.reduce((s, a) => s + a.toolbeltCoverage, 0) / perSession.length))
    : 0;

  const withCommits = perSession.filter(a => a.commitVelocity !== null);
  const commitVelocity = withCommits.length > 0
    ? Math.round(withCommits.reduce((s, a) => s + a.commitVelocity, 0) / withCommits.length)
    : null;

  // Composite score (0-100): clamp and weight each component. Toolbelt coverage
  // is deliberately NOT scored — it measures tool variety, not autonomy quality
  // (a focused Edit+Bash session shouldn't grade "low"). It's reported as a
  // descriptor only. Self-heal needs enough shell activity to mean anything;
  // below the threshold it's neutral (50) rather than a punishing 0.
  const MIN_BASH_FOR_SELFHEAL = 5;
  const autopilotScore = Math.round(Math.min(autopilotRatio / 5, 1) * 100);
  const selfHealWeighted = totalBash >= MIN_BASH_FOR_SELFHEAL ? selfHealScore : 50;
  const velocityScore = commitVelocity !== null
    ? Math.round(Math.max(0, Math.min(1, 1 - (commitVelocity / 100))) * 100)
    : 50; // neutral when no commits

  const overallScore = Math.round(
    autopilotScore * 0.30 +
    selfHealWeighted * 0.35 +
    velocityScore * 0.35
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
    breakdown: { autopilotScore, selfHealWeighted, velocityScore },
  };
}

function computeEfficiencyGrade(costPerCommit, survivalRate) {
  // Grade based on cost per commit (more meaningful than raw token count).
  // survivalRate is null when no lines are old enough to judge — grade on
  // cost alone rather than treating missing evidence as perfect survival.
  const survivalOk = (min) => survivalRate === null || survivalRate >= min;
  if (costPerCommit <= 2 && survivalOk(90)) return 'A';
  if (costPerCommit <= 5 && survivalOk(75)) return 'B';
  if (costPerCommit <= 15 && survivalOk(50)) return 'C';
  if (costPerCommit <= 40 && survivalOk(25)) return 'D';
  return 'F';
}

function computeEfficiencyScore(costPerCommit, survivalRate, orphanedRate, totalCommits) {
  if (totalCommits === 0) {
    return {
      score: 0, tier: 'Getting Started', letter: 'F',
      explanation: 'No commits matched to sessions yet — this is normal for exploratory work.',
      tip: 'Commits are matched by file overlap with agent-edited files.',
    };
  }

  // Score: 50 pts from cost efficiency (log scale) + 50 pts from survival rate.
  // Survival is neutral (half marks) while no lines are old enough to judge —
  // a fabricated 100% would bank 50 points on zero evidence.
  let costScore;
  if (costPerCommit <= 2) costScore = 50;
  else if (costPerCommit >= 50) costScore = 0;
  else costScore = Math.max(0, 50 * (1 - Math.log(costPerCommit / 2) / Math.log(25)));
  const survivalScore = survivalRate === null ? 25 : Math.min(survivalRate, 100) / 100 * 50;
  const score = Math.round(costScore + survivalScore);

  const tier = score >= 80 ? 'Excellent' : score >= 60 ? 'Solid' : score >= 40 ? 'Developing' : score >= 20 ? 'Early' : 'Getting Started';
  const letter = score >= 80 ? 'A' : score >= 60 ? 'B' : score >= 40 ? 'C' : score >= 20 ? 'D' : 'F';

  // Build explanation from actual metrics
  const costAdj = costPerCommit <= 2 ? 'excellent' : costPerCommit <= 5 ? 'good' : costPerCommit <= 15 ? 'moderate' : 'high';
  const explanation = `$${costPerCommit.toFixed(2)}/commit (${costAdj})` +
    (survivalRate === null ? ' · survival pending (code <24h old)' : ` · ${Math.round(survivalRate)}% code survival`);

  // Actionable tip based on weakest metric
  let tip;
  if (costScore < survivalScore) {
    tip = 'Try shorter, focused sessions to reduce cost per commit.';
  } else if (survivalRate !== null && survivalRate < 50) {
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
  // Grade on cost-per-commit only. We don't compute reliable per-session survival
  // (single-session samples are too small), so plugging in a fake constant would
  // make the survival half of the grade meaningless.
  const costPerCommit = session.cost.totalCost / session.commitCount;
  if (costPerCommit <= 2) return 'A';
  if (costPerCommit <= 5) return 'B';
  if (costPerCommit <= 15) return 'C';
  if (costPerCommit <= 40) return 'D';
  return 'F';
}

function generateInsights(summary, correlatedSessions, modelBreakdown, sessionBuckets, _tokenAnalytics, autonomyMetrics) {
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
        text: `${pct}% of sessions (${orphanedCount}/${correlatedSessions.length}) ran 10+ messages without producing a commit — likely wasted effort.`,
      });
    } else if (pct > 0) {
      candidates.push({
        priority: 3,
        type: 'info',
        text: `${pct}% of sessions (${orphanedCount}/${correlatedSessions.length}) ran 10+ messages without producing a commit.`,
      });
    }
  }

  // 2. Self-heal warning — critical behavioral signal
  if (autonomyMetrics && autonomyMetrics.totalBashCalls > 20 && autonomyMetrics.selfHealScore < 10) {
    candidates.push({
      priority: 1,
      type: 'warning',
      text: `Only ${autonomyMetrics.selfHealScore}% of ${autonomyMetrics.totalBashCalls} shell commands were tests or lints — low self-healing.`,
    });
  } else if (autonomyMetrics && autonomyMetrics.selfHealScore >= 40 && autonomyMetrics.totalBashCalls > 10) {
    candidates.push({
      priority: 3,
      type: 'success',
      text: `${autonomyMetrics.selfHealScore}% of shell commands were tests/lints — solid self-healing habit.`,
    });
  }

  // 3. Model cost efficiency — actionable comparison. One-commit samples
  // produce absurd ratios, so both compared families need a minimum of
  // commits before the insight fires.
  const MIN_COMMITS_FOR_COST_COMPARE = 3;
  const modelFamilies = Object.entries(modelBreakdown)
    .filter(([, d]) => d.sessions > 0 && d.avgCostPerCommit && d.commits >= MIN_COMMITS_FOR_COST_COMPARE);
  if (modelFamilies.length > 1) {
    const sorted = [...modelFamilies].sort((a, b) => a[1].avgCostPerCommit - b[1].avgCostPerCommit);
    const best = sorted[0];
    const worst = sorted[sorted.length - 1];
    const ratio = worst[1].avgCostPerCommit / best[1].avgCostPerCommit;
    if (ratio >= 2) {
      candidates.push({
        priority: 2,
        type: 'info',
        // "-family models" keeps the phrasing unambiguous when a family name
        // collides with an agent name (e.g. "Codex" on the Codex tab).
        text: `${capitalise(worst[0])}-family models cost ${ratio.toFixed(1)}x more per commit than ${capitalise(best[0])}-family models.`,
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

  // 8. Model token efficiency — distinct from cost ratio (tokens ≠ cost)
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
  // Display form of a model family. Codex families need casing that naive
  // capitalization can't produce ('gpt' → 'GPT', 'o-series' → 'o-series').
  const special = { gpt: 'GPT', codex: 'Codex', 'o-series': 'o-series' };
  return special[s] || s.charAt(0).toUpperCase() + s.slice(1);
}

export function computeMetrics(correlatedSessions, organicCommits, commitsByRepo, days, planConfig = null) {
  // Same calendar cutoff as the parser and git-analyzer — used to clamp
  // whole-session fields (startTime) that precede the window when a session
  // was resumed inside it.
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);
  const cutoffMs = cutoffDate.getTime();

  // ---- Summary ----
  const totalCost = correlatedSessions.reduce((s, c) => s + c.cost.totalCost, 0);
  const totalSessions = correlatedSessions.length;
  const totalCommits = correlatedSessions.reduce((s, c) => s + c.commitCount, 0);
  const totalLinesAdded = correlatedSessions.reduce((s, c) => s + c.linesAdded, 0);
  const totalLinesDeleted = correlatedSessions.reduce((s, c) => s + c.linesDeleted, 0);
  const totalNetLines = totalLinesAdded - totalLinesDeleted;
  // Unique AI-touched files: keyed by repo + path (the same relative path in
  // two repos is two files) and filtered to files the session actually wrote,
  // matching the AI-attributed line counts displayed beside this number.
  const totalFilesChanged = new Set(
    correlatedSessions.flatMap(s => {
      const sessionFiles = new Set(s.filesWritten || []);
      const chatOnly = sessionFiles.size === 0;
      return s.commits.flatMap(co => co.files
        .filter(f => chatOnly || sessionFiles.has(f.path))
        .map(f => `${s.repoPath || ''}|${f.path}`));
    })
  ).size;
  const totalInputTokens = correlatedSessions.reduce((s, c) => s + c.totalInputTokens, 0);
  const totalOutputTokens = correlatedSessions.reduce((s, c) => s + c.totalOutputTokens, 0);
  const orphanedCount = correlatedSessions.filter(s => s.isOrphaned).length;
  const totalCommitsOnMain = correlatedSessions.reduce((s, c) => s + c.commitsOnMain, 0);

  const lineSurvival = computeLineSurvival(correlatedSessions);

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
    // Fallback day for sessions with no per-day data, clamped so a straddling
    // session can't create timeline days before the analyzed window.
    const startDate = toDateStr(Math.max(new Date(session.startTime).getTime(), cutoffMs));

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

    // Count each session once, on its first in-window activity day, so
    // sum(daily.sessions) equals totalSessions without creating pre-window
    // timeline days for sessions that started before the lookback window.
    const firstActivityDay = session.dailyUsage && Object.keys(session.dailyUsage).length > 0
      ? Object.keys(session.dailyUsage).sort()[0]
      : startDate;
    ensureDay(firstActivityDay).sessions++;

    // Commits attributed to their own timestamps. Lines use the AI-attributed
    // (session-file-overlap) counts so the timeline reconciles with
    // summary.totalLinesAdded and the survival metric.
    for (const commit of session.commits) {
      const commitDate = toDateStr(commit.timestamp);
      const cDay = ensureDay(commitDate);
      const { added, deleted } = commitLinesForSession(session, commit);
      cDay.commits++;
      cDay.linesAdded += added;
      cDay.linesDeleted += deleted;
      cDay.netLines += added - deleted;
    }
  }
  // Gap-fill zero rows for every missing calendar day between the first and
  // last active day — sparse data (a few active days across months) would
  // otherwise render as an evenly-spaced, smoothly-interpolated fake trend on
  // the timeline chart. Bounded by the --days window since active days are.
  const activeDays = [...dailyMap.keys()].sort();
  if (activeDays.length > 1) {
    const lastMs = Date.parse(activeDays[activeDays.length - 1] + 'T12:00:00');
    // Noon-anchored stepping absorbs DST hour shifts without skipping a date
    for (let t = Date.parse(activeDays[0] + 'T12:00:00'); t <= lastMs; t += 24 * 3600 * 1000) {
      ensureDay(toDateStr(t));
    }
  }
  const daily = [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date));

  // Best/worst days. When enough days have non-trivial spend, rank those by
  // commits-per-dollar using their true cost (all are >= the floor, so no absurd
  // ratios). When every day with commits is trivially cheap, $/commit is just
  // noise — rank by raw productivity (commit count) instead of a floored ratio.
  const RANK_MIN_COST = 0.5;
  const daysWithCommits = daily.filter(d => d.commits > 0);
  const rankPool = daysWithCommits.filter(d => d.cost >= RANK_MIN_COST);
  let bestDay = null;
  let worstDay = null;
  if (rankPool.length > 0) {
    const eff = (d) => d.commits / d.cost;
    bestDay = rankPool.reduce((a, b) => eff(b) > eff(a) ? b : a);
    worstDay = rankPool.reduce((a, b) => eff(b) < eff(a) ? b : a);
  } else if (daysWithCommits.length > 0) {
    bestDay = daysWithCommits.reduce((a, b) => b.commits > a.commits ? b : a);
    worstDay = daysWithCommits.reduce((a, b) => b.commits < a.commits ? b : a);
  }

  // ---- Model breakdown ----
  // Cost and tokens are split across families by ACTUAL usage (accurate for the
  // spend/usage charts). Sessions and commits are attributed in WHOLE numbers — a
  // session counts once for every family it used, and all of its commits are
  // credited to that session's dominant family (most tokens) — so per-family
  // avgCostPerCommit is computed from integer commits, not fractional ones.
  const modelBreakdown = {};
  const ensureFamily = (family) => {
    if (!modelBreakdown[family]) {
      modelBreakdown[family] = { cost: 0, tokens: 0, sessions: 0, commits: 0, dominantCost: 0, avgCostPerCommit: null, subModels: {} };
    }
    return modelBreakdown[family];
  };
  for (const session of correlatedSessions) {
    // Aggregate this session's usage by family
    const famAgg = {};
    for (const [model, data] of Object.entries(session.modelBreakdown)) {
      const family = getModelFamily(model) || 'unknown';
      if (!famAgg[family]) famAgg[family] = { cost: 0, tokens: 0, models: {} };
      famAgg[family].cost += data.cost;
      famAgg[family].tokens += data.tokens;
      if (!famAgg[family].models[model]) famAgg[family].models[model] = { cost: 0, tokens: 0 };
      famAgg[family].models[model].cost += data.cost;
      famAgg[family].models[model].tokens += data.tokens;
    }
    // Dominant family for this session (by token volume)
    let domFamily = null;
    let domTokens = -1;
    for (const [family, agg] of Object.entries(famAgg)) {
      if (agg.tokens > domTokens) { domTokens = agg.tokens; domFamily = family; }
    }
    for (const [family, agg] of Object.entries(famAgg)) {
      const fam = ensureFamily(family);
      fam.cost += agg.cost;
      fam.tokens += agg.tokens;
      fam.sessions += 1; // this session used this family
      for (const [model, md] of Object.entries(agg.models)) {
        if (!fam.subModels[model]) fam.subModels[model] = { cost: 0, tokens: 0 };
        fam.subModels[model].cost += md.cost;
        fam.subModels[model].tokens += md.tokens;
      }
    }
    if (domFamily) {
      const fam = ensureFamily(domFamily);
      fam.commits += session.commitCount;
      // Cost of the sessions where this family was dominant — the matching
      // population for its commits, so avgCostPerCommit divides like with like
      // (family-wide cost includes sessions whose commits went to other families).
      fam.dominantCost += session.cost.totalCost;
    }
  }
  for (const data of Object.values(modelBreakdown)) {
    data.avgCostPerCommit = data.commits > 0 ? data.dominantCost / data.commits : null;
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
  // Sessions that started before the window are excluded: their message counts
  // are whole-session while their cost/commits are window-clipped, so bucketing
  // them would pair a long-session label with a sliver of its real cost and
  // skew the "sweet spot" insight.
  const buckets = { '1-50': [], '51-100': [], '101-200': [], '200+': [] };
  for (const session of correlatedSessions) {
    if (new Date(session.startTime).getTime() < cutoffMs) continue;
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

  // ---- Heatmap (hour x day-of-week), placed at each commit's actual timestamp ----
  const heatmap = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const session of correlatedSessions) {
    for (const commit of session.commits) {
      const d = new Date(commit.timestamp);
      heatmap[d.getDay()][d.getHours()]++;
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
  // Rolling 7-day window, matching the weekly narrative's definition of "this
  // week" so the two "this week" figures use the same boundary.
  const startOfWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const mkPeriod = () => ({ cost: 0, sessions: 0, commits: 0, tokens: 0 });
  const costByPeriod = { today: mkPeriod(), week: mkPeriod(), month: mkPeriod(), allTime: mkPeriod() };
  for (const session of correlatedSessions) {
    // Same window clamp as the daily timeline's fallback day
    const startDateStr = toDateStr(Math.max(new Date(session.startTime).getTime(), cutoffMs));

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

  const pricingEstimatedCost = correlatedSessions.reduce((s, c) => s + (c.estimatedCost || 0), 0);
  // Attribution confidence + reconciliation — make the headline numbers auditable:
  // how many commits were confidently AI's vs. weakly-matched vs. organic (manual),
  // and how the line counts reconcile (AI-attributed ⊆ AI-commit-total + organic).
  const confCommits = { high: 0, medium: 0, low: 0 };
  for (const s of correlatedSessions) {
    if (s.commitCount > 0 && s.attributionConfidence) confCommits[s.attributionConfidence] += s.commitCount;
  }
  const aiCommitLinesTotal = correlatedSessions.reduce(
    (a, s) => a + s.commits.reduce((x, c) => x + (c.totalAdded || 0), 0), 0);
  const organicLines = organicCommits.reduce((a, c) => a + (c.totalAdded || 0), 0);
  const reconciliation = {
    commits: { aiMatched: totalCommits, organic: organicCommits.length, byConfidence: confCommits },
    lines: {
      aiAttributed: totalLinesAdded,       // lines in AI-written files within AI-matched commits
      aiCommitsTotal: aiCommitLinesTotal,  // all lines in AI-matched commits (incl. files the AI didn't write)
      organic: organicLines,               // lines in commits with no matched session
    },
  };

  // Subscription "effective cost" mode (only when a plan is supplied). Reframes
  // API-equivalent spend against the flat fee actually paid, prorated to the
  // analyzed window. utilizationRatio = API-equivalent value / fee — an estimate
  // of value extracted, NOT realized savings (subscription users pay the flat fee
  // regardless of usage).
  const plan = planConfig ? (() => {
    const windowCost = planConfig.monthlyCost * (days / 30);
    return {
      name: planConfig.name,
      monthlyCost: planConfig.monthlyCost,
      windowDays: days,
      windowCost: Math.round(windowCost * 100) / 100,
      apiEquivalentCost: Math.round(totalCost * 100) / 100,
      utilizationRatio: windowCost > 0 ? Math.round((totalCost / windowCost) * 100) / 100 : null,
      effectiveCostPerCommit: totalCommits > 0 ? Math.round((windowCost / totalCommits) * 100) / 100 : null,
      effectiveCostPerSurvivingLine: lineSurvival.surviving > 0 ? Math.round((windowCost / lineSurvival.surviving) * 10000) / 10000 : null,
    };
  })() : null;

  const summary = {
    totalCost,
    pricingEstimatedPct: totalCost > 0 ? Math.round((pricingEstimatedCost / totalCost) * 100) : 0,
    reconciliation,
    plan,
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
  const autonomyMetrics = computeAutonomyMetrics(correlatedSessions, cutoffMs);

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

  const weeklyNarrative = buildWeeklyNarrative(correlatedSessions, autonomyMetrics);

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      daysAnalyzed: days,
      // Clamped to the window cutoff — a session resumed inside the window
      // carries a pre-window startTime, but every number displayed under this
      // date range excludes that period (mirror of the endTime-based endDate).
      startDate: correlatedSessions.length > 0
        ? new Date(Math.max(cutoffMs, Math.min(...correlatedSessions.map(s => new Date(s.startTime).getTime())))).toISOString()
        : null,
      endDate: correlatedSessions.length > 0
        ? new Date(Math.max(...correlatedSessions.map(s => new Date(s.endTime || s.startTime).getTime()))).toISOString()
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
    heatmap: { commits: heatmap },
    weeklyNarrative,
    organicCommits,
  };
}
