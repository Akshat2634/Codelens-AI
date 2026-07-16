import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dayKeyInZone, resolveWindow, validateDateStr, validateTz } from '../../src/window.js';

test('validateTz accepts real IANA zones and UTC, rejects bogus strings', () => {
  assert.equal(validateTz(null), null);
  assert.equal(validateTz(undefined), null);
  assert.equal(validateTz('America/New_York'), null);
  assert.equal(validateTz('UTC'), null);
  assert.match(validateTz('Not/AZone'), /Unknown --tz "Not\/AZone"/);
});

test('validateDateStr requires YYYY-MM-DD and a parseable date', () => {
  assert.equal(validateDateStr('2026-06-01', '--since'), null);
  assert.match(validateDateStr('2026/06/01', '--since'), /--since must be YYYY-MM-DD/);
  assert.match(validateDateStr('06-01-2026', '--until'), /--until must be YYYY-MM-DD/);
  assert.match(validateDateStr('2026-13-40', '--since'), /--since must be YYYY-MM-DD/);
});

test('dayKeyInZone with no tz matches the exact pre-existing getFullYear/getMonth/getDate formula', () => {
  const d = new Date('2026-07-15T23:00:00.000Z');
  const old = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  assert.equal(dayKeyInZone(d, null), old);
  assert.equal(dayKeyInZone(d, undefined), old);
});

test('dayKeyInZone: the issue\'s exact 23:30 ET / 03:30 UTC boundary case', () => {
  const ts = '2026-07-16T03:30:00.000Z';
  assert.equal(dayKeyInZone(ts, 'UTC'), '2026-07-16');
  assert.equal(dayKeyInZone(ts, 'America/New_York'), '2026-07-15');
});

test('resolveWindow days-mode is byte-identical to the pre-existing cutoffDate.setDate formula, untilMs stays null', () => {
  const now = Date.parse('2026-07-15T18:00:00.000Z');
  const w = resolveWindow({ days: 30, now });
  const expected = new Date(now);
  expected.setDate(expected.getDate() - 30);
  assert.equal(w.cutoffMs, expected.getTime());
  assert.equal(w.untilMs, null);
  assert.equal(w.days, 30);
});

test('resolveWindow range-mode: single-day round-trip holds across extreme zones and DST-transition dates', () => {
  const zones = ['America/New_York', 'Asia/Kolkata', 'Pacific/Kiritimati', 'Pacific/Niue', 'Australia/Lord_Howe', 'UTC'];
  const dates = ['2026-06-30', '2026-07-15', '2026-01-15', '2026-03-08', '2026-11-01', '2026-12-31'];
  for (const tz of zones) {
    for (const dateStr of dates) {
      const w = resolveWindow({ since: dateStr, until: dateStr, tz });
      assert.equal(dayKeyInZone(w.cutoffMs, tz), dateStr, `${tz} ${dateStr} start`);
      assert.equal(dayKeyInZone(w.untilMs, tz), dateStr, `${tz} ${dateStr} end`);
      assert.notEqual(dayKeyInZone(w.untilMs + 1, tz), dateStr, `${tz} ${dateStr} +1ms rolls to next day`);
    }
  }
});

test('resolveWindow range-mode: full June in America/New_York is exactly June 1 through June 30, 30 days', () => {
  const w = resolveWindow({ since: '2026-06-01', until: '2026-06-30', tz: 'America/New_York' });
  assert.equal(dayKeyInZone(w.cutoffMs, 'America/New_York'), '2026-06-01');
  assert.equal(dayKeyInZone(w.untilMs, 'America/New_York'), '2026-06-30');
  assert.equal(dayKeyInZone(w.untilMs + 1, 'America/New_York'), '2026-07-01');
  assert.equal(w.days, 30, 'June has 30 days — since/until are both inclusive');
});

test('resolveWindow: a single day (since === until) spans exactly 1 day', () => {
  const w = resolveWindow({ since: '2026-06-30', until: '2026-06-30', tz: 'UTC' });
  assert.equal(w.days, 1);
});

test('resolveWindow: since without until leaves untilMs open (now); until without since leaves cutoffMs null', () => {
  const now = Date.parse('2026-07-15T12:00:00Z');
  const onlySince = resolveWindow({ since: '2026-06-01', now });
  assert.equal(onlySince.untilMs, now);
  assert.ok(onlySince.cutoffMs < now);

  const onlyUntil = resolveWindow({ until: '2026-06-30' });
  assert.equal(onlyUntil.cutoffMs, null);
  assert.equal(onlyUntil.days, null);
});

test('resolveWindow: cutoffDay differs by since/until/tz so distinct ranges never share a cache fingerprint', () => {
  const a = resolveWindow({ since: '2026-06-01', until: '2026-06-30', tz: 'UTC' });
  const b = resolveWindow({ since: '2026-06-01', until: '2026-06-30', tz: 'America/New_York' });
  const c = resolveWindow({ since: '2026-07-01', until: '2026-07-31', tz: 'UTC' });
  assert.notEqual(a.cutoffDay, b.cutoffDay);
  assert.notEqual(a.cutoffDay, c.cutoffDay);
});
