import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blocksJson, buildBlocks, filterRecentBlocks, renderBlocksText } from '../../src/blocks.js';

const H = 60 * 60 * 1000;
const MIN = 60 * 1000;
// A fixed UTC base: 2026-01-01 09:30 UTC. floorToHour → 09:00.
const base = Date.UTC(2026, 0, 1, 9, 30);
const hour0 = Date.UTC(2026, 0, 1, 9, 0);

// Helper: one session carrying an explicit usageEvents timeline.
function sess(events) {
  return { source: 'claude', usageEvents: events };
}
function ev(ts, { input = 0, output = 0, cacheRead = 0, cacheCreate = 0, cost = 0 } = {}) {
  return { ts, input, output, cacheRead, cacheCreate, cost };
}

test('single block when all events fall within the 5h window', () => {
  const s = sess([
    ev(base, { input: 100, cost: 1 }),
    ev(base + 90 * MIN, { input: 100, cost: 1 }),
    ev(base + 3 * H, { input: 100, cost: 1 }),
  ]);
  const { blocks } = buildBlocks([s], { nowMs: base + 10 * H });
  const real = blocks.filter((b) => !b.isGap);
  assert.equal(real.length, 1);
  assert.equal(real[0].startTime, hour0);            // floored to the hour
  assert.equal(real[0].endTime, hour0 + 5 * H);
  assert.equal(real[0].events, 3);
  assert.equal(real[0].tokens.input, 300);
});

test('new block starts when the 5h window elapses (no gap block if idle < 5h)', () => {
  const s = sess([
    ev(base, { input: 100, cost: 1 }),
    ev(base + 90 * MIN, { input: 100, cost: 1 }),
    ev(base + 5 * H + 1, { input: 100, cost: 1 }), // > 5h since block start
  ]);
  const { blocks } = buildBlocks([s], { nowMs: base + 12 * H });
  const real = blocks.filter((b) => !b.isGap);
  const gaps = blocks.filter((b) => b.isGap);
  assert.equal(real.length, 2);
  assert.equal(gaps.length, 0); // idle since last entry was < 5h, so no gap block
});

test('a >5h idle gap inserts a gap block and starts a fresh block', () => {
  const s = sess([
    ev(base, { input: 100, cost: 1 }),
    ev(base + 6 * H, { input: 100, cost: 1 }), // 6h after last entry → gap
  ]);
  const { blocks } = buildBlocks([s], { nowMs: base + 12 * H });
  const gaps = blocks.filter((b) => b.isGap);
  const real = blocks.filter((b) => !b.isGap);
  assert.equal(real.length, 2);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].totalTokens, 0);
  assert.match(gaps[0].id, /^gap-/);
});

test('events across sessions merge into shared billing windows', () => {
  const a = sess([ev(base, { input: 100, cost: 1 })]);
  const b = sess([ev(base + 60 * MIN, { input: 200, cost: 2 })]); // same window
  const { blocks } = buildBlocks([a, b], { nowMs: base + 10 * H });
  const real = blocks.filter((x) => !x.isGap);
  assert.equal(real.length, 1);
  assert.equal(real[0].tokens.input, 300);
  assert.equal(real[0].cost, 3);
});

test('burn rate: tokens/min uses all classes, indicator excludes cache, $/hr scales', () => {
  const s = sess([
    ev(base, { input: 1000, output: 500, cacheRead: 4000, cost: 1 }),
    ev(base + 10 * MIN, { input: 100, output: 50, cost: 0.1 }),
  ]);
  const { blocks } = buildBlocks([s], { nowMs: base + 10 * H });
  const b = blocks.find((x) => !x.isGap);
  // total tokens = 5500 + 150 = 5650 over 10 min
  assert.equal(b.totalTokens, 5650);
  assert.equal(b.burnRate.tokensPerMinute, 565);
  // indicator excludes cacheRead: (1000+500+100+50)/10 = 165
  assert.equal(b.burnRate.tokensPerMinuteIndicator, 165);
  // cost/hr = (1.1 / 10) * 60 = 6.6
  assert.ok(Math.abs(b.burnRate.costPerHour - 6.6) < 1e-9);
});

test('single-event block has null burn rate (zero active span)', () => {
  const s = sess([ev(base, { input: 100, cost: 1 })]);
  const { blocks } = buildBlocks([s], { nowMs: base + 10 * H });
  assert.equal(blocks.find((b) => !b.isGap).burnRate, null);
});

test('active block detection + projection to end of window', () => {
  const s = sess([
    ev(base, { input: 1000, output: 500, cacheRead: 4000, cost: 1 }),
    ev(base + 10 * MIN, { input: 100, output: 50, cost: 0.1 }),
  ]);
  // now = 30 min after block start; block runs hour0 .. hour0+5h.
  const now = base + 30 * MIN;
  const { activeBlock } = buildBlocks([s], { nowMs: now });
  assert.ok(activeBlock, 'expected an active block');
  // remaining = end (hour0+5h) - now
  const remaining = (hour0 + 5 * H - now) / MIN;
  assert.equal(activeBlock.projection.remainingMinutes, Math.round(remaining));
  // projected tokens = current + rate * remaining
  const expected = Math.round(5650 + 565 * remaining);
  assert.equal(activeBlock.projection.projectedTotalTokens, expected);
});

test('no active block when the window has elapsed', () => {
  const s = sess([ev(base, { input: 100, cost: 1 })]);
  const { activeBlock } = buildBlocks([s], { nowMs: base + 8 * H });
  assert.equal(activeBlock, null);
});

test('--token-limit number and "max" drive percent-of-limit on the active block', () => {
  const s = sess([
    ev(base - 6 * H, { input: 9000, cost: 1 }),           // prior block, 9000 tokens
    ev(base, { input: 1000, output: 0, cost: 0.5 }),      // active block
    ev(base + 5 * MIN, { input: 1000, output: 0, cost: 0.5 }),
  ]);
  const now = base + 10 * MIN;
  const num = buildBlocks([s], { nowMs: now, tokenLimit: 10000 });
  assert.equal(num.activeBlock.limit, 10000);
  assert.equal(num.activeBlock.percentOfLimit, 20); // 2000 / 10000
  const max = buildBlocks([s], { nowMs: now, tokenLimit: 'max' });
  assert.equal(max.limit, 9000); // largest block seen
});

test('filterRecentBlocks keeps only blocks active within N days', () => {
  const s = sess([
    ev(base - 10 * 24 * H, { input: 100, cost: 1 }), // 10 days before base
    ev(base, { input: 100, cost: 1 }),
  ]);
  const now = base + 1 * H;
  const result = buildBlocks([s], { nowMs: now });
  const recent = filterRecentBlocks(result, 3);
  assert.ok(recent.blocks.every((b) => b.actualEndTime >= now - 3 * 24 * H));
  assert.ok(recent.blocks.length < result.blocks.filter((b) => !b.isGap).length);
});

test('empty input yields no blocks and no active block', () => {
  const r = buildBlocks([], { nowMs: base });
  assert.deepEqual(r.blocks, []);
  assert.equal(r.activeBlock, null);
});

test('custom --session-length changes the window length', () => {
  const s = sess([
    ev(base, { input: 100, cost: 1 }),
    ev(base + 4 * H, { input: 100, cost: 1 }), // within 5h, but > 3h
  ]);
  const five = buildBlocks([s], { nowMs: base + 20 * H, sessionHours: 5 });
  const three = buildBlocks([s], { nowMs: base + 20 * H, sessionHours: 3 });
  assert.equal(five.blocks.filter((b) => !b.isGap).length, 1);
  assert.equal(three.blocks.filter((b) => !b.isGap).length, 2); // 4h > 3h window
});

test('blocksJson exposes ISO times, token counts, and burn/projection on active', () => {
  const s = sess([
    ev(base, { input: 1000, output: 500, cost: 1 }),
    ev(base + 10 * MIN, { input: 100, output: 50, cost: 0.1 }),
  ]);
  const result = buildBlocks([s], { nowMs: base + 20 * MIN, tokenLimit: 5000 });
  const doc = blocksJson(result, { source: 'all' });
  assert.equal(doc.report, 'blocks');
  assert.equal(doc.source, 'all');
  assert.ok(doc.activeBlock);
  assert.equal(doc.activeBlock.startTime, new Date(hour0).toISOString());
  assert.ok(doc.activeBlock.burnRate.tokensPerMinute > 0);
  assert.ok(doc.activeBlock.projection.projectedTotalTokens >= doc.activeBlock.totalTokens);
  assert.equal(doc.activeBlock.tokenLimit, 5000);
});

test('renderBlocksText: table lists windows; --active shows the open block', () => {
  const s = sess([
    ev(base, { input: 1000, output: 500, cost: 1 }),
    ev(base + 10 * MIN, { input: 100, output: 50, cost: 0.1 }),
  ]);
  const result = buildBlocks([s], { nowMs: base + 20 * MIN });
  const table = renderBlocksText(result, { color: false });
  assert.match(table, /Window \(start/);
  assert.match(table, /Burn/);
  const activeView = renderBlocksText(result, { active: true, color: false });
  assert.match(activeView, /Active block/);
  assert.match(activeView, /Burn rate/);
  assert.match(activeView, /Projected end-of-block/);
});

test('renderBlocksText --active with no open block is a friendly message', () => {
  const s = sess([ev(base, { input: 100, cost: 1 })]);
  const result = buildBlocks([s], { nowMs: base + 8 * H });
  const out = renderBlocksText(result, { active: true, color: false });
  assert.match(out, /No active 5-hour block/);
});
