import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FONT, renderBanner, WORD } from '../../src/banner.js';

// Biome (noControlCharactersInRegex) disallows \x1b in regex literals, so all
// ANSI handling here is plain string surgery on the escape character.
const ESC = '\x1b';
const stripAnsi = (s) =>
  s
    .split(ESC)
    .map((part, i) => (i === 0 ? part : part.slice(part.indexOf('m') + 1)))
    .join('');

test('wordmark rows are rectangular (equal visible width)', () => {
  const lines = renderBanner('1.2.3').split('\n');
  // The art block is the run of lines containing block glyphs.
  const art = lines.filter((l) => stripAnsi(l).includes('█'));
  assert.equal(art.length, 5, 'wordmark should be 5 rows tall');
  const glyphWidths = [...WORD].map((ch) => FONT[ch][0].length);
  const expected = glyphWidths.reduce((a, w) => a + w, 0) + (WORD.length - 1) + 2; // glyphs + gaps + indent
  for (const row of art) {
    assert.equal(stripAnsi(row).length, expected, `row width mismatch: ${JSON.stringify(stripAnsi(row))}`);
  }
  assert.ok(expected <= 80, 'wordmark must fit an 80-column terminal');
});

test('banner includes the version and the help hint', () => {
  const out = stripAnsi(renderBanner('9.9.9'));
  assert.ok(out.includes('codelens-ai v9.9.9'));
  assert.ok(out.includes('--help'));
});

test('color: false emits no ANSI escape codes', () => {
  const out = renderBanner('1.2.3', { color: false });
  assert.ok(!out.includes(ESC), 'expected no escape sequences');
  assert.ok(out.includes('█'), 'art should still render as plain blocks');
});

test('color output paints each letter and resets', () => {
  const out = renderBanner('1.2.3');
  const opens = out.split(`${ESC}[38;5;`).length - 1;
  const resets = out.split(`${ESC}[0m`).length - 1;
  assert.ok(opens > 0, 'expected 256-color foreground codes');
  assert.ok(resets >= opens, 'every color open should be reset');
});
