import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBadgeMarkdown, buildBadgeSvg, buildDigestHtml } from '../../src/artifacts.js';

function mkPayload(overrides = {}) {
  return {
    meta: { generatedAt: '2026-06-29T10:00:00.000Z', daysAnalyzed: 30 },
    summary: {
      totalCost: 42.5,
      totalInputTokens: 100000,
      totalOutputTokens: 50000,
      efficiencyScore: { letter: 'B' },
      pricing: { plan: 'api', apiEquivalentCost: 42.5, isSubscription: false, proratedPlanCost: null },
    },
    lineSurvival: { surviving: 1200, survivalRate: 85, byLanguage: [] },
    qualityOutcomes: { reworkRatePct: 5 },
    costControl: { cacheHitRate: 90 },
    streaks: { current: 3, longest: 12 },
    weeklyNarrative: {
      headline: 'You shipped 8 commits at $2.10 each',
      metrics: [{ label: 'Commits', value: '8', deltaPct: 20, direction: 'higher-better' }],
      bullets: ['Opus carried 80% of spend.'],
      thisWeek: { cost: 16.8 },
      priorWeek: { cost: 21.0 },
    },
    ...overrides,
  };
}

test('buildBadgeSvg produces a self-contained SVG with survival-led stats', () => {
  const svg = buildBadgeSvg(mkPayload());
  assert.ok(svg.startsWith('<svg'), 'starts with <svg');
  assert.ok(svg.includes('</svg>'), 'closes svg');
  assert.ok(svg.includes('1,200'), 'shows surviving lines');
  assert.ok(svg.includes('85%'), 'shows survival rate');
  assert.ok(svg.includes('12d'), 'shows longest streak');
  assert.ok(svg.includes('>B<'), 'shows grade');
  // Only the SVG namespace URI is allowed; no fetchable external assets.
  assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(svg), 'no external asset URLs (offline-safe)');
  assert.ok(!/<image|xlink:href|src=/.test(svg), 'no external image/script references');
});

test('buildBadgeSvg is plan-aware (subscription shows flat fee, free shows tokens)', () => {
  const pro = buildBadgeSvg(mkPayload({
    summary: { ...mkPayload().summary, pricing: { plan: 'pro', apiEquivalentCost: 42.5, isSubscription: true, proratedPlanCost: 20 } },
  }));
  assert.ok(pro.includes('$20.00'), 'pro plan shows prorated flat fee');
  const free = buildBadgeSvg(mkPayload({
    summary: { ...mkPayload().summary, pricing: { plan: 'free', apiEquivalentCost: 42.5 } },
  }));
  assert.ok(/tokens/.test(free), 'free plan shows tokens, not dollars');
});

test('buildDigestHtml returns a valid standalone HTML doc with the narrative', () => {
  const html = buildDigestHtml(mkPayload());
  assert.ok(html.toLowerCase().startsWith('<!doctype html>'), 'is an HTML doc');
  assert.ok(html.includes('Weekly Digest'), 'has digest title');
  assert.ok(html.includes('You shipped 8 commits'), 'includes the headline');
  assert.ok(html.includes('1,200'), 'includes surviving lines');
  assert.ok(!/https?:\/\/(?!schemas|semver|keepachangelog)/.test(html), 'no external asset URLs');
});

test('buildDigestHtml escapes HTML in dynamic content', () => {
  const html = buildDigestHtml(mkPayload({
    weeklyNarrative: { ...mkPayload().weeklyNarrative, headline: 'pwn <script>alert(1)</script>' },
  }));
  assert.ok(!html.includes('<script>alert(1)</script>'), 'raw script tag is escaped');
  assert.ok(html.includes('&lt;script&gt;'), 'escaped form present');
});

test('buildBadgeMarkdown references the svg path', () => {
  const md = buildBadgeMarkdown('./codelens-badge.svg');
  assert.ok(md.includes('./codelens-badge.svg'));
  assert.ok(md.includes('codelens-ai'));
});

test('artifacts handle an empty/zero payload without throwing', () => {
  const empty = {
    meta: { daysAnalyzed: 30 },
    summary: { totalCost: 0, totalInputTokens: 0, totalOutputTokens: 0, efficiencyScore: { letter: 'F' }, pricing: { plan: 'api', apiEquivalentCost: 0 } },
    lineSurvival: { surviving: 0, survivalRate: 0, byLanguage: [] },
    qualityOutcomes: {},
    costControl: {},
    streaks: { current: 0, longest: 0 },
    weeklyNarrative: null,
  };
  assert.ok(buildBadgeSvg(empty).startsWith('<svg'));
  assert.ok(buildDigestHtml(empty).toLowerCase().startsWith('<!doctype html>'));
});
