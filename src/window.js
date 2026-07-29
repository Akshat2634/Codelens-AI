// Shared lookback-window resolution + timezone-aware calendar-day bucketing.
//
// Before this module, `--days` → cutoff and "which calendar day is this
// timestamp" were each computed independently in ~6 places (both parsers,
// metrics.js, tables.js, git-analyzer.js, index.js) via the server process's
// implicit local timezone. Centralizing here means `--since`/`--until`/`--tz`
// only need to be correct once, and the existing `--days`-only path is
// byte-identical to before (see the no-`tz` branches below).

const DAY_MS = 24 * 60 * 60 * 1000;

// null on success, else a user-facing error string.
export function validateTz(tz) {
  if (!tz) return null;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return null;
  } catch {
    return `Unknown --tz "${tz}". Use an IANA zone name, e.g. America/New_York or UTC.`;
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// null on success, else a user-facing error string.
export function validateDateStr(value, flagName) {
  if (!DATE_RE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    return `${flagName} must be YYYY-MM-DD, got "${value}".`;
  }
  return null;
}

// Calendar day (YYYY-MM-DD) containing `dateLike`, in `tz` (IANA zone) or the
// server's local zone when `tz` is falsy — the exact formula every existing
// caller used before --tz existed, so the no-tz path is unchanged.
export function dayKeyInZone(dateLike, tz) {
  const d = new Date(dateLike);
  if (!tz) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

// UTC instant for 00:00:00.000 local time on `dateStr`, in `tz` (or the
// server's local zone when `tz` is falsy). JS has no native "construct a Date
// from Y-M-D in an arbitrary named zone" — this rebuilds it by taking a UTC
// guess, asking Intl what wall-clock time that guess renders as in the target
// zone, and correcting by the difference (handles DST correctly since it
// reads the real rendered offset, not a static table). Verified against
// Kiritimati (UTC+14), Niue (UTC-11), Lord Howe's 30-minute DST shift, and
// both 2026 US DST-transition dates.
function startOfDayMs(dateStr, tz) {
  if (!tz) return Date.parse(dateStr + 'T00:00:00.000');
  const utcGuessMs = Date.parse(dateStr + 'T00:00:00.000Z');
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  // formatToParts repeats type:'literal' for every separator — filtered out so
  // Object.fromEntries can't have one overwrite a same-typed field.
  const p = Object.fromEntries(fmt.formatToParts(utcGuessMs).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
  const renderedAsUtc = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
  return utcGuessMs - (renderedAsUtc - utcGuessMs);
}

// Calendar-string arithmetic only (not a real timezone conversion) — noon UTC
// is DST-proof for this, mirroring the same "noon avoids boundary skew" trick
// already used elsewhere in this codebase (claude-parser.js's day-priced cost
// loop, tables.js's weekStartOf).
function addOneDayToDateStr(dateStr) {
  const d = new Date(Date.parse(dateStr + 'T12:00:00Z') + DAY_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// End-of-day = 1ms before the start of the next day. Deliberately NOT
// computed as "T23:59:59.999" directly: formatToParts only returns whole
// seconds, so the zone-offset correction above would lose the .999 fraction
// and can round across the day boundary — this route never touches
// milliseconds until the final "- 1".
function zonedDayBoundaryMs(dateStr, tz, endOfDay) {
  if (!endOfDay) return startOfDayMs(dateStr, tz);
  return startOfDayMs(addOneDayToDateStr(dateStr), tz) - 1;
}

// Resolves the analysis lookback window to {cutoffMs, untilMs, days, cutoffDay}.
//   - days mode (since/until absent): cutoffMs = now - days (the exact
//     pre-existing formula), untilMs = null (open-ended, "up to now").
//   - range mode: cutoffMs/untilMs bound the [since, until] range in `tz`;
//     `days` is derived (inclusive day span) for display/plan-proration only.
// Every consumer downstream writes new `untilMs` checks as `!untilMs || <cmp>`
// — a no-op in days mode, so the default path is unaffected by this feature.
export function resolveWindow({ days, since, until, tz, now = Date.now() } = {}) {
  if (since || until) {
    const cutoffMs = since ? zonedDayBoundaryMs(since, tz, false) : null;
    const untilMs = until ? zonedDayBoundaryMs(until, tz, true) : now;
    // untilMs (when `until` is set) is "1ms before the next day starts" — add
    // that 1ms back before dividing so June 1..June 30 comes out to exactly
    // 30, not 31. Only valid for that sentinel; `now` (the no-`until` default)
    // isn't a day boundary, so it's left as-is.
    const spanEndMs = until ? untilMs + 1 : untilMs;
    const span = cutoffMs != null ? Math.round((spanEndMs - cutoffMs) / DAY_MS) : null;
    return { cutoffMs, untilMs, days: span, cutoffDay: `${since || ''}:${until || ''}:${tz || ''}` };
  }
  const cutoffDate = new Date(now);
  cutoffDate.setDate(cutoffDate.getDate() - days);
  return { cutoffMs: cutoffDate.getTime(), untilMs: null, days, cutoffDay: cutoffDate.toDateString() };
}
