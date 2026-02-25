const POST_SESSION_BUFFER_MS = 30 * 60 * 1000; // 30 minutes after session end

export function correlateSessions(sessions, commitsByRepo) {
  const result = [];
  const claimedCommits = new Set(); // track commits already assigned to a session

  // Sort sessions by end time so earlier sessions claim commits first
  const sorted = [...sessions].sort(
    (a, b) => new Date(a.endTime).getTime() - new Date(b.endTime).getTime()
  );

  for (const session of sorted) {
    const repoAnalysis = commitsByRepo[session.repoPath];
    const repoCommits = repoAnalysis?.commits || [];

    const sessionStart = new Date(session.startTime).getTime();
    const sessionEnd = new Date(session.endTime).getTime();
    const windowEnd = sessionEnd + POST_SESSION_BUFFER_MS;

    // Find commits within the session window, not already claimed
    const matched = repoCommits.filter(c =>
      c.timestampMs >= sessionStart &&
      c.timestampMs <= windowEnd &&
      !claimedCommits.has(c.hash)
    );

    // Mark these commits as claimed
    for (const c of matched) {
      claimedCommits.add(c.hash);
    }

    const linesAdded = matched.reduce((s, c) => s + c.totalAdded, 0);
    const linesDeleted = matched.reduce((s, c) => s + c.totalDeleted, 0);
    const netLines = linesAdded - linesDeleted;
    const filesChanged = new Set(matched.flatMap(c => c.files.map(f => f.path))).size;
    const commitsOnMain = matched.filter(c => c.onMain).length;

    const messageCount = session.userMessageCount + session.assistantMessageCount;
    const isOrphaned = messageCount > 10 && matched.length === 0;

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
      costPerCommit: matched.length > 0 ? session.cost.totalCost / matched.length : null,
      costPerLine: linesAdded > 0 ? session.cost.totalCost / linesAdded : null,
      costPerNetLine: netLines > 0 ? session.cost.totalCost / netLines : null,
    });
  }

  // Identify organic commits (not claimed by any session)
  const organicCommits = [];
  for (const [repoPath, analysis] of Object.entries(commitsByRepo)) {
    for (const commit of analysis.commits) {
      if (!claimedCommits.has(commit.hash)) {
        organicCommits.push({ ...commit, repoPath });
      }
    }
  }

  // Re-sort result by start time descending (most recent first for display)
  result.sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());

  return { correlatedSessions: result, organicCommits };
}
