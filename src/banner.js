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
const ROWS = FONT[WORD[0]].length;

// RGB stops for the wordmark sweep: gold → orange → coral → magenta → violet
// → sky. Interpolated per pixel along a diagonal, so every column (and each
// row, slightly shifted) gets its own hue — a smooth sunset ramp rather than
// flat per-letter tints. "AI" lands on the violet/sky tail as its own accent.
const PALETTE = [
  [255, 214, 90],
  [255, 135, 0],
  [255, 95, 95],
  [255, 0, 135],
  [175, 95, 255],
  [95, 175, 255],
];
// Rows shift the gradient right by this many columns each, tilting the sweep
// into a diagonal instead of plain left-to-right.
const ROW_SHIFT = 3;

// Linear interpolation across PALETTE at t ∈ [0, 1].
function paletteAt(t) {
  const scaled = Math.min(Math.max(t, 0), 1) * (PALETTE.length - 1);
  const i = Math.min(Math.floor(scaled), PALETTE.length - 2);
  const f = scaled - i;
  const [a, b] = [PALETTE[i], PALETTE[i + 1]];
  return [0, 1, 2].map((k) => Math.round(a[k] + (b[k] - a[k]) * f));
}

// Nearest xterm-256 color-cube index, for terminals without truecolor.
function toXterm256([r, g, b]) {
  const scale = (v) => Math.round((v / 255) * 5);
  return 16 + 36 * scale(r) + 6 * scale(g) + scale(b);
}

const supportsTruecolor = () => /truecolor|24bit/i.test(process.env.COLORTERM || '');

export function renderBanner(version, { color = true, truecolor = supportsTruecolor() } = {}) {
  const fg = (rgb) => (truecolor ? `\x1b[38;2;${rgb.join(';')}m` : `\x1b[38;5;${toXterm256(rgb)}m`);
  const dim = (s) => (color ? `\x1b[2m${s}\x1b[0m` : s);
  const bold = (s) => (color ? `\x1b[1m${s}\x1b[0m` : s);

  const glyphs = [...WORD].map((ch) => FONT[ch]);
  const width = glyphs.reduce((a, g) => a + g[0].length, 0) + glyphs.length - 1;
  const span = width - 1 + ROW_SHIFT * (ROWS - 1); // full diagonal extent
  const art = [];
  for (let r = 0; r < ROWS; r++) {
    let row = '  ';
    let open = null; // last emitted color — only switch codes when the hue changes
    let x = 0;
    for (const cell of glyphs.map((g) => g[r]).join(' ')) {
      if (cell === '#') {
        if (color) {
          const code = fg(paletteAt((x + r * ROW_SHIFT) / span));
          if (code !== open) {
            row += code;
            open = code;
          }
        }
        row += '█';
      } else {
        row += ' '; // gaps inherit no visible color; one reset per row suffices
      }
      x++;
    }
    art.push(open ? `${row}\x1b[0m` : row);
  }

  return [
    '',
    ...art,
    '',
    '  Measure the ROI of your AI coding agents. From the terminal.',
    '',
    `  ${color ? `${fg([95, 255, 135])}●\x1b[0m` : '●'} ${bold(`codelens-ai v${version}`)} ${dim('· Claude Code + OpenAI Codex · all data stays local')}`,
    '',
    `  ${dim('Run codelens-ai --help to see every command.')}`,
    '',
  ].join('\n');
}

export { FONT, WORD };
