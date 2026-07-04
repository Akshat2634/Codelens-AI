const FALLBACK_BUFFER_MS = 2 * 60 * 60 * 1000; // 2 hours for time-only fallback
// Minimum combined message count (user + assistant) before a chat-only session
// may claim commits by time proximity alone. Without this floor a trivial
// seconds-long, one-message session absorbs whole manual commits that merely
// landed within the 2h buffer, fabricating AI-attributed lines and grades.
const MIN_CHAT_ONLY_MESSAGES = 5;

function computeOverlappingLines(commits, sessionFiles) {
  let linesAdded = 0;
  let linesDeleted = 0;
  for (const c of commits) {
    for (const f of c.files) {
      if (sessionFiles.has(f.path)) {
        linesAdded += f.added;
        linesDeleted += f.deleted;
      }
    }
  }
  return { linesAdded, linesDeleted };
}

/**
 * AI-attributed line counts for a single (session, commit) pair: the added/
 * deleted lines in files the session actually wrote (filesWritten ∩ commit.files).
 * For chat-only sessions (no filesWritten) the whole commit is attributed.
 * This is the single definition of "AI lines" used across the codebase so that
 * per-session, daily-timeline, and code-survival totals reconcile exactly.
 */
export function commitLinesForSession(session, commit) {
  const sessionFiles = new Set(session.filesWritten || []);
  if (sessionFiles.size === 0) {
    return { added: commit.totalAdded || 0, deleted: commit.totalDeleted || 0 };
  }
  let added = 0;
  let deleted = 0;
  for (const f of commit.files) {
    if (sessionFiles.has(f.path)) {
      added += f.added;
      deleted += f.deleted;
    }
  }
  return { added, deleted };
}

/**
 * Compute the temporal distance between a commit and a session.
 * Returns the minimum absolute distance from the commit to the session's
 * time range (0 if the commit falls within the session window).
 */
function temporalDistance(commitMs, sessionStartMs, sessionEndMs) {
  if (commitMs >= sessionStartMs && commitMs <= sessionEndMs) return 0;
  return Math.min(
    Math.abs(commitMs - sessionStartMs),
    Math.abs(commitMs - sessionEndMs)
  );
}

/**
 * Correlate sessions to commits using file-based matching.
 *
 * Uses a two-pass "nearest session wins" approach:
 *   1. For each commit, find all candidate sessions (file overlap + time window)
 *      and assign it to the temporally closest one.
 *   2. Build correlated results from those assignments.
 *
 * Primary: match commits whose changed files overlap with session.filesWritten.
 *   Time constraint: commit is within [sessionStart, sessionEnd + 2 hours].
 * Fallback: for sessions with no filesWritten (chat-only) that have plausible
 *   substance (>= MIN_CHAT_ONLY_MESSAGES messages), use time window
 *   [sessionStart, sessionEnd + 2 hours].
 *
 * cutoffMs (the lookback-window start) clamps the matching window of sessions
 * that started before the window but were kept because they were resumed
 * inside it: their raw [start, end] range spans the entire window, giving
 * temporal distance 0 to EVERY commit and stealing attribution from the
 * sessions that actually did the work. Their window starts at their first
 * in-window activity day instead.
 */
export function correlateSessions(sessions, commitsByRepo, cutoffMs = 0) {
  // Phase 1: Build candidate map — for each commit, find the best session
  // commitHash -> { session, hasFileOverlap }
  const commitAssignment = new Map();

  for (const session of sessions) {
    const repoAnalysis = commitsByRepo[session.repoPath];
    const repoCommits = repoAnalysis?.commits || [];

    let sessionStartMs = new Date(session.startTime).getTime();
    if (cutoffMs && sessionStartMs < cutoffMs) {
      const firstDay = Object.keys(session.dailyUsage || {}).sort()[0];
      sessionStartMs = firstDay
        ? Math.max(Date.parse(firstDay + 'T00:00:00'), cutoffMs)
        : cutoffMs;
    }
    const sessionEndMs = new Date(session.endTime).getTime();
    const sessionFiles = new Set(session.filesWritten || []);
    const windowEnd = sessionEndMs + FALLBACK_BUFFER_MS;
    const sessionSource = session.source || 'claude';

    for (const commit of repoCommits) {
      // Time constraint: commit must fall within [sessionStart, sessionEnd + 2h]
      if (commit.timestampMs < sessionStartMs || commit.timestampMs > windowEnd) continue;

      const hasFileOverlap = sessionFiles.size > 0 &&
        commit.files.some(f => sessionFiles.has(f.path));
      const chatOnlyEligible = sessionFiles.size === 0 &&
        (session.userMessageCount + session.assistantMessageCount) >= MIN_CHAT_ONLY_MESSAGES;

      // Must have file overlap, or be a substantial chat-only session
      // (time-based fallback)
      if (!hasFileOverlap && !chatOnlyEligible) continue;

      // A Co-authored-by trailer names the agent that stamped the commit —
      // near-ground-truth for WHICH agent's session should claim it.
      const trailerMatch = !!commit.aiTrailer && commit.aiTrailer === sessionSource;
      const distance = temporalDistance(commit.timestampMs, sessionStartMs, sessionEndMs);
      const existing = commitAssignment.get(commit.hash);

      if (!existing) {
        commitAssignment.set(commit.hash, { session, hasFileOverlap, trailerMatch, distance });
      } else {
        // Preference order: file-based match beats time-only match; within the
        // same match type, a session from the agent named in the commit's
        // co-author trailer beats one from another agent; then the temporally
        // closer session wins, with exact ties broken by the more recent
        // session start so attribution is deterministic (not dependent on
        // session iteration order).
        const better =
          hasFileOverlap !== existing.hasFileOverlap ? hasFileOverlap :
          trailerMatch !== existing.trailerMatch ? trailerMatch :
          distance !== existing.distance ? distance < existing.distance :
          new Date(session.startTime).getTime() > new Date(existing.session.startTime).getTime();
        if (better) {
          commitAssignment.set(commit.hash, { session, hasFileOverlap, trailerMatch, distance });
        }
      }
    }
  }

  // Phase 2: Group commits by assigned session
  const sessionCommits = new Map(); // sessionId -> commit[]
  for (const [hash, { session }] of commitAssignment) {
    if (!sessionCommits.has(session.sessionId)) {
      sessionCommits.set(session.sessionId, []);
    }
    // Find the actual commit object from the repo
    const repoAnalysis = commitsByRepo[session.repoPath];
    const commit = repoAnalysis?.commits?.find(c => c.hash === hash);
    if (commit) {
      sessionCommits.get(session.sessionId).push(commit);
    }
  }

  // Phase 3: Build correlated results
  const claimedCommits = new Set(commitAssignment.keys());
  const result = [];

  for (const session of sessions) {
    const sessionFiles = new Set(session.filesWritten || []);
    const matched = sessionCommits.get(session.sessionId) || [];

    let linesAdded, linesDeleted;
    if (sessionFiles.size > 0) {
      ({ linesAdded, linesDeleted } = computeOverlappingLines(matched, sessionFiles));
    } else {
      linesAdded = matched.reduce((s, c) => s + c.totalAdded, 0);
      linesDeleted = matched.reduce((s, c) => s + c.totalDeleted, 0);
    }
    const netLines = linesAdded - linesDeleted;
    const filesChanged = sessionFiles.size > 0
      ? new Set(matched.flatMap(c => c.files.filter(f => sessionFiles.has(f.path)).map(f => f.path))).size
      : new Set(matched.flatMap(c => c.files.map(f => f.path))).size;
    const commitsOnMain = matched.filter(c => c.onMain).length;

    const messageCount = session.userMessageCount + session.assistantMessageCount;
    const isOrphaned = messageCount > 10 && matched.length === 0;

    // Attribution confidence: how sure are we these commits are THIS session's
    // work? Three signals, all already computed during matching:
    //   - trailerFrac: share of matched commits whose Co-authored-by trailer
    //     names this session's agent — near-ground-truth (the agent stamped
    //     the commit itself), so a majority of stamped commits is high
    //     confidence outright.
    //   - overlapFrac: share of the matched commits' added lines that landed in
    //     files the session actually wrote (filesWritten ∩ commit.files).
    //   - inWindowFrac: share of commits made inside the session window
    //     (distance 0) vs. claimed via the 2h post-session buffer.
    // File evidence dominates timing: agents don't run `git commit` for the
    // user, so commits routinely land minutes AFTER the session ends — a low
    // inWindowFrac only downgrades a strong file match to medium, never low.
    // Weak file overlap (< 20% of added lines) is low regardless of timing.
    // Chat-only (time-only) matches have no file evidence → low, unless the
    // commits carry this agent's trailer.
    let attributionConfidence = null;
    let trailerConfirmedCommits = 0;
    const sessionSource = session.source || 'claude';
    if (matched.length > 0) {
      let inWindow = 0;
      let overlapAdded = 0;
      let totalAddedAll = 0;
      for (const c of matched) {
        const a = commitAssignment.get(c.hash);
        if (a && a.distance === 0) inWindow++;
        totalAddedAll += c.totalAdded || 0;
        if (c.aiTrailer && c.aiTrailer === sessionSource) trailerConfirmedCommits++;
        if (sessionFiles.size > 0) {
          overlapAdded += c.files.filter(f => sessionFiles.has(f.path)).reduce((x, f) => x + f.added, 0);
        }
      }
      const overlapFrac = sessionFiles.size === 0 ? 0 : (totalAddedAll > 0 ? overlapAdded / totalAddedAll : 1);
      const inWindowFrac = inWindow / matched.length;
      const trailerFrac = trailerConfirmedCommits / matched.length;
      if (trailerFrac >= 0.5) attributionConfidence = 'high';
      else if (sessionFiles.size === 0) attributionConfidence = 'low';
      else if (overlapFrac >= 0.5) attributionConfidence = inWindowFrac >= 0.5 ? 'high' : 'medium';
      else if (overlapFrac < 0.2) attributionConfidence = 'low';
      else attributionConfidence = 'medium';
    }

    result.push({
      ...session,
      commits: matched,
      commitCount: matched.length,
      commitsOnMain,
      linesAdded,
      linesDeleted,
      netLines,
      filesChanged,
      isOrphaned,
      attributionConfidence,
      trailerConfirmedCommits,
      costPerCommit: matched.length > 0 ? session.cost.totalCost / matched.length : null,
    });
  }

  // Identify organic commits (not claimed by any session). Dedupe by hash —
  // the same repository reachable under two paths (manual worktree, second
  // clone) yields identical commit lists, and pushing a commit once per repo
  // entry would double-count organic totals.
  const organicCommits = [];
  const seenOrganic = new Set();
  for (const [, analysis] of Object.entries(commitsByRepo)) {
    for (const commit of analysis.commits) {
      if (!claimedCommits.has(commit.hash) && !seenOrganic.has(commit.hash)) {
        seenOrganic.add(commit.hash);
        organicCommits.push({ ...commit });
      }
    }
  }

  // Sort result by start time descending (most recent first for display)
  result.sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());

  return { correlatedSessions: result, organicCommits };
}
