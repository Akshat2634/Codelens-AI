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
        } else if (hasFileOverlap === existing.hasFileOverlap && distance < existing.distance) {
          // Same match type — prefer temporally closer session
          commitAssignment.set(commit.hash, { session, hasFileOverlap, distance });
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
      matchedByFiles: sessionFiles.size > 0,
      uncommittedFiles,
      costPerCommit: matched.length > 0 ? session.cost.totalCost / matched.length : null,
      costPerLine: linesAdded > 0 ? session.cost.totalCost / linesAdded : null,
      costPerNetLine: netLines > 0 ? session.cost.totalCost / netLines : null,
    });
  }

  // Identify organic commits (not claimed by any session)
  const organicCommits = [];
  for (const [, analysis] of Object.entries(commitsByRepo)) {
    for (const commit of analysis.commits) {
      if (!claimedCommits.has(commit.hash)) {
        organicCommits.push({ ...commit });
      }
    }
  }

  // Sort result by start time descending (most recent first for display)
  result.sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());

  return { correlatedSessions: result, organicCommits };
}
