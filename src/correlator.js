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
 * Correlate sessions to commits using file-based matching.
 *
 * Primary: match commits whose changed files overlap with session.filesWritten.
 *   Time constraint: commit is on the same calendar day or the next day.
 * Fallback: for sessions with no filesWritten (chat-only), use time window
 *   [sessionStart, sessionEnd + 2 hours].
 */
export function correlateSessions(sessions, commitsByRepo) {
  const result = [];
  const claimedCommits = new Set();

  // Sort sessions by end time so earlier sessions claim commits first
  const sorted = [...sessions].sort(
    (a, b) => new Date(a.endTime).getTime() - new Date(b.endTime).getTime()
  );

  for (const session of sorted) {
    const repoAnalysis = commitsByRepo[session.repoPath];
    const repoCommits = repoAnalysis?.commits || [];

    const sessionStart = new Date(session.startTime).getTime();
    const sessionEnd = new Date(session.endTime).getTime();
    const sessionFiles = new Set(session.filesWritten || []);

    let matched;

    if (sessionFiles.size > 0) {
      // PRIMARY: File-based correlation
      // Time window: same calendar day as session, or next calendar day
      const sessionDay = new Date(session.startTime);
      const dayStart = new Date(sessionDay.getFullYear(), sessionDay.getMonth(), sessionDay.getDate()).getTime();
      const dayEnd = dayStart + 2 * 24 * 60 * 60 * 1000; // end of next calendar day

      matched = repoCommits.filter(c => {
        if (claimedCommits.has(c.hash)) return false;
        if (c.timestampMs < dayStart || c.timestampMs >= dayEnd) return false;
        // Check file overlap: any commit file matches a session file
        return c.files.some(f => sessionFiles.has(f.path));
      });
    } else {
      // FALLBACK: Time-based for chat-only sessions (no files written)
      const windowEnd = sessionEnd + FALLBACK_BUFFER_MS;
      matched = repoCommits.filter(c =>
        c.timestampMs >= sessionStart &&
        c.timestampMs <= windowEnd &&
        !claimedCommits.has(c.hash)
      );
    }

    // Claim matched commits
    for (const c of matched) {
      claimedCommits.add(c.hash);
    }

    let linesAdded, linesDeleted;
    if (sessionFiles.size > 0) {
      // Only count lines from files Claude actually edited
      ({ linesAdded, linesDeleted } = computeOverlappingLines(matched, sessionFiles));
    } else {
      // Fallback (chat-only): count all lines in matched commits
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

    // Calculate which session files were committed vs not
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

  // Re-sort result by start time descending (most recent first for display)
  result.sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());

  return { correlatedSessions: result, organicCommits };
}
