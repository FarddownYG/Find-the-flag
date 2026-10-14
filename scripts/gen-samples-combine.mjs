// Two near-identical PNGs: B = A with a message XOR-ed into the green LSB.
// Combining them (XOR / difference) reveals "flag{twin_xor}". Run: node scripts/gen-samples-combine.mjs
import { writeFileSync } from 'node:fs';
import { encode } from 'fast-png';

const W = 160;
const H = 40;
let seed = 0x1234567;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 16) & 0xff;

// 5x7 glyphs, one string per row, '#' = lit.
const FONT = {
  f: ['..##.', '.#...', '####.', '.#...', '.#...', '.#...', '.#...'],
  l: ['.##..', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  a: ['.....', '.....', '.###.', '....#', '.####', '#...#', '.####'],
  g: ['.....', '.####', '#...#', '.####', '....#', '#...#', '.###.'],
  '{': ['..##.', '.#...', '.#...', '#....', '.#...', '.#...', '..##.'],
  '}': ['.##..', '...#.', '...#.', '....#', '...#.', '...#.', '.##..'],
  t: ['.#...', '.#...', '####.', '.#...', '.#...', '.#..#', '..##.'],
  w: ['.....', '.....', '#...#', '#...#', '#.#.#', '#.#.#', '.#.#.'],
  i: ['..#..', '.....', '.##..', '..#..', '..#..', '..#..', '.###.'],
  n: ['.....', '.....', '#.##.', '##..#', '#...#', '#...#', '#...#'],
  _: ['.....', '.....', '.....', '.....', '.....', '.....', '#####'],
  x: ['.....', '.....', '#...#', '.#.#.', '..#..', '.#.#.', '#...#'],
  o: ['.....', '.....', '.###.', '#...#', '#...#', '#...#', '.###.'],
  r: ['.....', '.....', '#.##.', '##..#', '#....', '#....', '#....'],
};

const a = new Uint8Array(W * H * 4);
for (let i = 0; i < W * H; i++) {
  a[i * 4] = rnd();
  a[i * 4 + 1] = rnd();
  a[i * 4 + 2] = rnd();
  a[i * 4 + 3] = 255;
}
const b = a.slice();
const text = 'flag{twin_xor}';
const scale = 2;
let x0 = 4;
for (const ch of text) {
  const glyph = FONT[ch];
  for (let gy = 0; gy < 7; gy++) {
    for (let gx = 0; gx < 5; gx++) {
      if (glyph[gy][gx] !== '#') continue;
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const x = x0 + gx * scale + sx;
          const y = 12 + gy * scale + sy;
          if (x < W) b[(y * W + x) * 4 + 1] ^= 1;
        }
      }
    }
  }
  x0 += 6 * scale - 1;
}

writeFileSync(
  new URL('../public/samples/stego-twin-a.png', import.meta.url),
  encode({ width: W, height: H, data: a, channels: 4, depth: 8 }),
);
writeFileSync(
  new URL('../public/samples/stego-twin-b.png', import.meta.url),
  encode({ width: W, height: H, data: b, channels: 4, depth: 8 }),
);
console.log('stego-twin-a.png, stego-twin-b.png');
