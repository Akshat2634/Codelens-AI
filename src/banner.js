// Big pixel-block startup wordmark, shown only on interactive dashboard runs
// (TTY stdout, not --json). Every other surface keeps the compact one-line
// banner in index.js: subcommand output is often piped, and `mcp` stdout may
// carry nothing but JSON-RPC frames.

// 5-row pixel font covering exactly the glyphs of the wordmark. Rows within a
// glyph are equal width; '#' cells render as blocks, spaces stay gaps. The
// ' ' glyph is the word break (1 col + the 2 join gaps around it = 3 visible).
const FONT = {
  C: [' ####', '#    ', '#    ', '#    ', ' ####'],
  O: [' ### ', '#   #', '#   #', '#   #', ' ### '],
  D: ['#### ', '#   #', '#   #', '#   #', '#### '],
  E: ['#####', '#    ', '#### ', '#    ', '#####'],
  L: ['#    ', '#    ', '#    ', '#    ', '#####'],
  N: ['#   #', '##  #', '# # #', '#  ##', '#   #'],
  S: [' ####', '#    ', ' ### ', '    #', '#### '],
  A: [' ### ', '#   #', '#####', '#   #', '#   #'],
  I: ['#####', '  #  ', '  #  ', '  #  ', '#####'],
  ' ': [' ', ' ', ' ', ' ', ' '],
};

const WORD = 'CODELENS AI';
// Warm gold→magenta→violet ramp, one 256-color stop per glyph — stays in the
// dashboard's warm-ink family without requiring truecolor support. The "AI"
// tail lands on the violet stops so it reads as its own accent.
const GRADIENT = [220, 214, 208, 209, 203, 198, 199, 163, 163, 135, 99];
const ROWS = FONT[WORD[0]].length;

export function renderBanner(version, { color = true } = {}) {
  const paint = (code, s) => (color ? `\x1b[38;5;${code}m${s}\x1b[0m` : s);
  const dim = (s) => (color ? `\x1b[2m${s}\x1b[0m` : s);
  const bold = (s) => (color ? `\x1b[1m${s}\x1b[0m` : s);

  const art = [];
  for (let r = 0; r < ROWS; r++) {
    const row = [...WORD]
      .map((ch, i) => paint(GRADIENT[i % GRADIENT.length], FONT[ch][r].replaceAll('#', '█')))
      .join(' ');
    art.push(`  ${row}`);
  }

  return [
    '',
    ...art,
    '',
    '  Measure the ROI of your AI coding agents. From the terminal.',
    '',
    `  ${paint(41, '●')} ${bold(`codelens-ai v${version}`)} ${dim('· Claude Code + OpenAI Codex · all data stays local')}`,
    '',
    `  ${dim('Run codelens-ai --help to see every command.')}`,
    '',
  ].join('\n');
}

export { FONT, WORD };
