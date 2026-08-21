// A provider-neutral evidence view over the session + git data Codelens already
// records. This module deliberately distinguishes an observed verification
// command from its result: current provider logs do not expose a reliable exit
// status across Claude Code, Codex, and Copilot.

const sourceName = (source) => ({
  claude: 'Claude Code',
  codex: 'OpenAI Codex',
  copilot: 'GitHub Copilot',
}[source] || source || 'Unknown agent');

const number = (value) => Number.isFinite(value) ? value : 0;
const shortHash = (hash) => String(hash || '').slice(0, 7);
const money = (value) => value === null ? 'unknown' : `$${number(value).toFixed(2)}`;

function uniqueVerificationCommands(session) {
  const commands = (session.bashCommands || [])
    .filter((item) => item?.isVerification === true && item.command)
    .map((item) => String(item.command).trim())
    .filter(Boolean);
  return [...new Set(commands)];
}

function commitTimestamp(commit) {
  const value = commit.timestamp ?? commit.timestampMs ?? null;
  if (value === null) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function selectEvidenceSession(sessions, sessionId = null) {
  if (!Array.isArray(sessions) || sessions.length === 0) return null;
  if (sessionId) return sessions.find((session) => session.sessionId === sessionId) || null;
  return [...sessions].sort((a, b) => {
    const aTime = Date.parse(a.endTime || a.startTime) || 0;
    const bTime = Date.parse(b.endTime || b.startTime) || 0;
    return bTime - aTime;
  })[0];
}

export function buildEvidence(session) {
  if (!session) return null;

  const contextType = session.contextType || (session.projectName ? 'repository' : 'task');
  const repository = contextType === 'repository';
  const commands = uniqueVerificationCommands(session);
  const commandCount = Math.max(number(session.verificationBashCalls), commands.length);
  const verificationObserved = commandCount > 0;
  const commits = (session.commits || []).map((commit) => ({
    hash: commit.hash || null,
    shortHash: shortHash(commit.hash),
    subject: commit.subject || null,
    onDefaultBranch: Boolean(commit.onMain),
    agentTrailer: commit.aiTrailer || null,
    timestamp: commitTimestamp(commit),
  }));
  const matched = repository && commits.length > 0;
  const changedFiles = number(session.filesChanged);
  const filesWritten = [...new Set(session.filesWritten || [])];
  const hasWorkEvidence = commits.length > 0 || filesWritten.length > 0 || number(session.totalBashCalls) > 0;
  const coverage = verificationObserved && (matched || filesWritten.length > 0)
    ? 'rich'
    : verificationObserved || hasWorkEvidence
      ? 'partial'
      : 'limited';

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    session: {
      id: session.sessionId,
      source: session.source || 'claude',
      sourceName: sourceName(session.source || 'claude'),
      entrypoint: session.entrypoint || null,
      model: session.model || null,
      startedAt: session.startTime || null,
      endedAt: session.endTime || session.startTime || null,
      cost: session.costZeroed ? null : number(session.cost?.totalCost),
      costStatus: session.costZeroed ? 'not_available' : 'observed',
    },
    context: {
      type: contextType,
      name: repository ? session.projectName : (session.taskName || null),
      repoPath: repository ? (session.repoPath || null) : null,
    },
    coverage,
    outcome: repository ? {
      status: matched ? 'matched' : 'not_observed',
      commitCount: commits.length,
      commitsOnDefaultBranch: number(session.commitsOnMain),
      filesChanged: changedFiles,
      linesAdded: number(session.linesAdded),
      linesDeleted: number(session.linesDeleted),
      filesWritten,
      commits,
      note: matched
        ? 'Git commits were matched to this session.'
        : 'No Git commit was matched to this session; this does not prove that no useful work occurred.',
    } : {
      status: 'not_applicable',
      commitCount: 0,
      commitsOnDefaultBranch: 0,
      filesChanged: 0,
      linesAdded: 0,
      linesDeleted: 0,
      filesWritten,
      commits: [],
      note: 'Repository outcome does not apply because this session was not attached to a Git repository.',
    },
    attribution: repository ? {
      status: matched ? 'matched' : 'not_observed',
      confidence: matched ? (session.attributionConfidence || 'unknown') : null,
      trailerConfirmedCommits: number(session.trailerConfirmedCommits),
      note: matched
        ? 'Confidence is based on agent trailers, file overlap, and session timing.'
        : 'Attribution requires a matched Git commit.',
    } : {
      status: 'not_applicable',
      confidence: null,
      trailerConfirmedCommits: 0,
      note: 'Commit attribution does not apply outside a Git repository.',
    },
    verification: {
      status: verificationObserved ? 'observed' : 'not_observed',
      result: 'unknown',
      commandCount,
      repeatCount: Math.max(0, commandCount - commands.length),
      commands,
      note: verificationObserved
        ? 'Verification commands were observed, but provider-neutral exit status is unavailable; Codelens does not claim they passed.'
        : 'No verification command was observed in the available session log; this is not evidence that checks failed.',
    },
    durability: {
      status: 'not_available',
      note: 'Per-session code survival is not yet available; the dashboard still reports aggregate 24-hour line survival.',
    },
    activity: {
      toolCalls: Object.values(session.toolCalls || {}).reduce((sum, count) => sum + number(count), 0),
      shellCalls: number(session.totalBashCalls),
      readOnlyShellCalls: number(session.readOnlyBashCalls),
    },
    disclaimer: 'This is workflow evidence, not a correctness guarantee.',
  };
}

function fmtTime(value) {
  if (!value) return 'unknown';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

export function renderEvidenceText(evidence, { color = true } = {}) {
  if (!evidence) return 'No session evidence found.';
  const ansi = color ? { bold: '\x1b[1m', cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', dim: '\x1b[2m', reset: '\x1b[0m' } : { bold: '', cyan: '', green: '', yellow: '', dim: '', reset: '' };
  const lines = [
    `${ansi.bold}${ansi.cyan}Session evidence${ansi.reset} ${ansi.dim}· ${evidence.coverage} coverage${ansi.reset}`,
    '',
    `Session       ${evidence.session.sourceName}${evidence.session.entrypoint ? ` · ${evidence.session.entrypoint}` : ''} · ${evidence.session.id}`,
    `Context       ${evidence.context.type === 'repository' ? 'Repository' : 'Task'} · ${evidence.context.name || 'unknown'}`,
    `Time          ${fmtTime(evidence.session.startedAt)} → ${fmtTime(evidence.session.endedAt)}`,
    `Model / cost  ${evidence.session.model || 'unknown'} · ${money(evidence.session.cost)}`,
  ];

  if (evidence.outcome.status === 'not_applicable') {
    lines.push('Outcome       N/A · session is not attached to a Git repository');
  } else if (evidence.outcome.status === 'matched') {
    lines.push(`Outcome       ${evidence.outcome.commitCount} matched commit${evidence.outcome.commitCount === 1 ? '' : 's'} · ${evidence.outcome.filesChanged} files · +${evidence.outcome.linesAdded}/-${evidence.outcome.linesDeleted}`);
    for (const commit of evidence.outcome.commits) {
      lines.push(`              ${commit.shortHash}  ${commit.subject || '(no subject)'}${commit.onDefaultBranch ? ' · default branch' : ''}`);
    }
    lines.push(`Attribution   ${evidence.attribution.confidence} confidence · ${evidence.attribution.trailerConfirmedCommits} trailer-confirmed`);
  } else {
    lines.push('Outcome       No matched Git commit observed');
    lines.push('Attribution   Not available without a matched commit');
  }

  lines.push(`Verification  ${evidence.verification.status === 'observed' ? `${evidence.verification.commandCount} command${evidence.verification.commandCount === 1 ? '' : 's'} observed` : 'No command observed'} · result unknown`);
  for (const command of evidence.verification.commands) lines.push(`              ${command}`);
  lines.push('', `${ansi.yellow}Boundary${ansi.reset}      ${evidence.verification.note}`, `${ansi.dim}${evidence.disclaimer}${ansi.reset}`);
  return lines.join('\n');
}

const mdCode = (value) => `\`${String(value).replaceAll('`', '\\`')}\``;

export function renderEvidenceMarkdown(evidence) {
  if (!evidence) return '# Session evidence\n\nNo session evidence found.\n';
  const outcome = evidence.outcome.status === 'not_applicable'
    ? 'Not applicable (not attached to a Git repository)'
    : evidence.outcome.status === 'matched'
      ? `${evidence.outcome.commitCount} matched commit${evidence.outcome.commitCount === 1 ? '' : 's'}; ${evidence.outcome.filesChanged} files; +${evidence.outcome.linesAdded}/-${evidence.outcome.linesDeleted}`
      : 'No matched Git commit observed';
  const attribution = evidence.attribution.status === 'matched'
    ? `${evidence.attribution.confidence} confidence; ${evidence.attribution.trailerConfirmedCommits} trailer-confirmed commit(s)`
    : evidence.attribution.status === 'not_applicable' ? 'Not applicable' : 'Not available';
  const verification = evidence.verification.status === 'observed'
    ? `${evidence.verification.commandCount} command(s) observed; result unknown`
    : 'No verification command observed; result unknown';
  const commitLines = evidence.outcome.commits.map((commit) =>
    `- ${mdCode(commit.shortHash)} ${commit.subject || '(no subject)'}${commit.onDefaultBranch ? ' (default branch)' : ''}`
  );
  const commandLines = evidence.verification.commands.map((command) => `- ${mdCode(command)}`);

  return [
    '# Session evidence',
    '',
    `> ${evidence.disclaimer}`,
    '',
    `- **Coverage:** ${evidence.coverage}`,
    `- **Session:** ${evidence.session.sourceName}${evidence.session.entrypoint ? ` / ${evidence.session.entrypoint}` : ''} / ${mdCode(evidence.session.id)}`,
    `- **Context:** ${evidence.context.type} / ${evidence.context.name || 'unknown'}`,
    `- **Time:** ${evidence.session.startedAt || 'unknown'} to ${evidence.session.endedAt || 'unknown'}`,
    `- **Model / cost:** ${evidence.session.model || 'unknown'} / ${money(evidence.session.cost)}`,
    `- **Outcome:** ${outcome}`,
    `- **Attribution:** ${attribution}`,
    `- **Verification:** ${verification}`,
    `- **Durability:** Not available per session yet`,
    '',
    '## Matched commits',
    '',
    ...(commitLines.length ? commitLines : ['None.']),
    '',
    '## Verification commands',
    '',
    ...(commandLines.length ? commandLines : ['None observed.']),
    '',
    '## Evidence boundary',
    '',
    evidence.verification.note,
    '',
  ].join('\n');
}
