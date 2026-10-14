// Synthetic sample for the "Channel reveal" tool. Deterministic: run it again and the bytes are
// identical. Nothing here is a real scan, a real printer mark or a real CTF challenge.
//
//   node scripts/gen-samples-channel.mjs
//
// Files:
//   channel-faint-text.png  560x96 white page with two lines of text drawn in RGB (255, 255, 236).
//                           The only difference to the paper is 19 levels in the blue channel,
//                           which the eye can hardly see; the blue channel (inverted) or the yellow
//                           channel shows it at full contrast. Red and green are constant 255.
//
// Uses only fast-png; the 5x8 bitmap font is hand-rolled below.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encode } from 'fast-png';

const outDir = fileURLToPath(new URL('../public/samples/', import.meta.url));
mkdirSync(outDir, { recursive: true });
const write = (name, bytes) => {
  writeFileSync(join(outDir, name), bytes);
  console.log(`${name}: ${bytes.length} bytes`);
};

// ---------- 5x8 bitmap font (lowercase, digits, { } _ - space) ----------

const FONT = {
  a: ['.....', '.....', '.###.', '....#', '.####', '#...#', '.####', '.....'],
  b: ['#....', '#....', '####.', '#...#', '#...#', '#...#', '####.', '.....'],
  c: ['.....', '.....', '.###.', '#...#', '#....', '#...#', '.###.', '.....'],
  d: ['....#', '....#', '.####', '#...#', '#...#', '#...#', '.####', '.....'],
  e: ['.....', '.....', '.###.', '#...#', '#####', '#....', '.###.', '.....'],
  f: ['..##.', '.#...', '####.', '.#...', '.#...', '.#...', '.#...', '.....'],
  g: ['.....', '.####', '#...#', '#...#', '.####', '....#', '#...#', '.###.'],
  h: ['#....', '#....', '####.', '#...#', '#...#', '#...#', '#...#', '.....'],
  i: ['..#..', '.....', '.##..', '..#..', '..#..', '..#..', '.###.', '.....'],
  l: ['.##..', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.', '.....'],
  n: ['.....', '.....', '####.', '#...#', '#...#', '#...#', '#...#', '.....'],
  o: ['.....', '.....', '.###.', '#...#', '#...#', '#...#', '.###.', '.....'],
  p: ['.....', '####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  s: ['.....', '.....', '.####', '#....', '.###.', '....#', '####.', '.....'],
  t: ['.#...', '.#...', '####.', '.#...', '.#...', '.#..#', '..##.', '.....'],
  u: ['.....', '.....', '#...#', '#...#', '#...#', '#..##', '.##.#', '.....'],
  v: ['.....', '.....', '#...#', '#...#', '#...#', '.#.#.', '..#..', '.....'],
  '{': ['..##.', '.#...', '.#...', '#....', '.#...', '.#...', '..##.', '.....'],
  '}': ['.##..', '...#.', '...#.', '....#', '...#.', '...#.', '.##..', '.....'],
  _: ['.....', '.....', '.....', '.....', '.....', '.....', '.....', '#####'],
};

/** Set mask[y*w+x] = 1 where the text is lit (each font pixel becomes a scale x scale block). */
function drawText(mask, w, text, x0, y0, scale) {
  let cx = x0;
  for (const ch of text) {
    const glyph = FONT[ch];
    if (!glyph) throw new Error(`no glyph for ${ch}`);
    glyph.forEach((row, gy) => {
      [...row].forEach((px, gx) => {
        if (px !== '#') return;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            mask[(y0 + gy * scale + dy) * w + cx + gx * scale + dx] = 1;
          }
        }
      });
    });
    cx += 6 * scale;
  }
}

// ---------- channel-faint-text.png ----------

{
  const W = 560;
  const H = 96;
  const mask = new Uint8Array(W * H);
  drawText(mask, W, 'hidden_in_plain_sight', 20, 16, 3);
  drawText(mask, W, 'flag{faint_but_not_invisible}', 20, 56, 3);
  const data = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    data[i * 3] = 255;
    data[i * 3 + 1] = 255;
    data[i * 3 + 2] = mask[i] ? 236 : 255;
  }
  write('channel-faint-text.png', encode({ width: W, height: H, data, depth: 8, channels: 3 }));
}
