const FALLBACK_BUFFER_MS = 2 * 60 * 60 * 1000; // 2 hours for time-only fallback

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
 * Fallback: for sessions with no filesWritten (chat-only), use time window
 *   [sessionStart, sessionEnd + 2 hours].
 */
export function correlateSessions(sessions, commitsByRepo) {
  // Phase 1: Build candidate map — for each commit, find the best session
  // commitHash -> { session, hasFileOverlap }
  const commitAssignment = new Map();

  for (const session of sessions) {
    const repoAnalysis = commitsByRepo[session.repoPath];
    const repoCommits = repoAnalysis?.commits || [];

    const sessionStartMs = new Date(session.startTime).getTime();
    const sessionEndMs = new Date(session.endTime).getTime();
    const sessionFiles = new Set(session.filesWritten || []);
    const windowEnd = sessionEndMs + FALLBACK_BUFFER_MS;

    for (const commit of repoCommits) {
      // Time constraint: commit must fall within [sessionStart, sessionEnd + 2h]
      if (commit.timestampMs < sessionStartMs || commit.timestampMs > windowEnd) continue;

      const hasFileOverlap = sessionFiles.size > 0 &&
        commit.files.some(f => sessionFiles.has(f.path));
      const isChatOnly = sessionFiles.size === 0;

      // Must have file overlap, or be a chat-only session (time-based fallback)
      if (!hasFileOverlap && !isChatOnly) continue;

      const distance = temporalDistance(commit.timestampMs, sessionStartMs, sessionEndMs);
      const existing = commitAssignment.get(commit.hash);

      if (!existing) {
        commitAssignment.set(commit.hash, { session, hasFileOverlap, distance });
      } else {
        // Prefer file-based match over time-only match
        if (hasFileOverlap && !existing.hasFileOverlap) {
          commitAssignment.set(commit.hash, { session, hasFileOverlap, distance });
        } else if (hasFileOverlap === existing.hasFileOverlap) {
          // Same match type — prefer the temporally closer session; break exact
          // ties by the more recent session start so attribution is deterministic
          // (not dependent on session iteration order).
          const tieToNewer = distance === existing.distance &&
            new Date(session.startTime).getTime() > new Date(existing.session.startTime).getTime();
          if (distance < existing.distance || tieToNewer) {
            commitAssignment.set(commit.hash, { session, hasFileOverlap, distance });
          }
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

    const committedFiles = new Set(matched.flatMap(c => c.files.map(f => f.path)));
    const uncommittedFiles = [...sessionFiles].filter(f => !committedFiles.has(f));

    // Attribution confidence: how sure are we these commits are THIS session's
    // work? Two signals, both already computed during matching:
    //   - overlapFrac: share of the matched commits' added lines that landed in
    //     files the session actually wrote (filesWritten ∩ commit.files).
    //   - inWindowFrac: share of commits made inside the session window
    //     (distance 0) vs. claimed via the 2h post-session buffer.
    // Chat-only (time-only) matches have no file evidence → low.
    let attributionConfidence = null;
    if (matched.length > 0) {
      let inWindow = 0;
      let overlapAdded = 0;
      let totalAddedAll = 0;
      for (const c of matched) {
        const a = commitAssignment.get(c.hash);
        if (a && a.distance === 0) inWindow++;
        totalAddedAll += c.totalAdded || 0;
        if (sessionFiles.size > 0) {
          overlapAdded += c.files.filter(f => sessionFiles.has(f.path)).reduce((x, f) => x + f.added, 0);
        }
      }
      const overlapFrac = sessionFiles.size === 0 ? 0 : (totalAddedAll > 0 ? overlapAdded / totalAddedAll : 1);
      const inWindowFrac = inWindow / matched.length;
      if (sessionFiles.size === 0) attributionConfidence = 'low';
      else if (overlapFrac >= 0.5 && inWindowFrac >= 0.5) attributionConfidence = 'high';
      else if (overlapFrac < 0.2 || inWindowFrac < 0.2) attributionConfidence = 'low';
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
      matchedByFiles: sessionFiles.size > 0,
      uncommittedFiles,
      costPerCommit: matched.length > 0 ? session.cost.totalCost / matched.length : null,
      costPerLine: linesAdded > 0 ? session.cost.totalCost / linesAdded : null,
      costPerNetLine: netLines > 0 ? session.cost.totalCost / netLines : null,
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
