// Deterministic sample for the Piet tool. Run: node scripts/gen-samples-piet.mjs
// Uses only fast-png.
//
// public/samples/esolang-piet-ftf.png is a home-made Piet program that prints "FTF". Codels are
// 4x4 pixels, so the tool has to detect the codel size. Layout (one codel = one character here,
// "#" is black):
//
//   [   B0   ][B1][     B2     ][B3][   B4   ]B5#B6#
//
// Every block is as tall as the picture (7 codels) except the last two. A block's size is the
// number pushed when the pointer leaves it, and the colour change from block to block picks the
// command:
//
//   B0 (70 codels) -> B1  push 70            B1 -> B2  out(char)  prints "F"
//   B2 (84 codels) -> B3  push 84            B3 -> B4  out(char)  prints "T"
//   B4 (70 codels) -> B5  push 70            B5 -> B6  out(char)  prints "F"
//
// B6 is the trap that ends the program: a column of three codels entered through its middle codel
// only. Coming back would need the codel chooser to pick the middle one, which it never does for
// an edge of three, so after eight blocked attempts the program ends.
import { mkdirSync, writeFileSync } from 'node:fs';
import { encode } from 'fast-png';

const OUT = new URL('../public/samples/', import.meta.url);
mkdirSync(OUT, { recursive: true });

const CODEL = 4;
const HEIGHT = 7;

// ---------- the 18 Piet colours ----------

// Hue order: red, yellow, green, cyan, blue, magenta. Shade order: light, normal, dark.
const HUE_CHANNELS = [
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
  [0, 1, 1],
  [0, 0, 1],
  [1, 0, 1],
];
const SHADE_LEVELS = [
  [0xff, 0xc0], // light
  [0xff, 0x00], // normal
  [0xc0, 0x00], // dark
];
const rgb = ({ hue, shade }) => {
  const [high, low] = SHADE_LEVELS[shade];
  return HUE_CHANNELS[hue].map((on) => (on ? high : low));
};

// (hue steps, shade steps) of the commands used here, from the Piet command table.
const CHANGE = { push: [0, 1], 'out(char)': [5, 2] };
const after = (colour, command) => ({
  hue: (colour.hue + CHANGE[command][0]) % 6,
  shade: (colour.shade + CHANGE[command][1]) % 3,
});

// ---------- the picture, in codels ----------

const BLACK = null;
const widthOf = [10, 1, 12, 1, 10]; // B0..B4, full height
const WIDTH = widthOf.reduce((a, b) => a + b, 0) + 2 + 1 + 1; // + B5 (2 wide), B6, black column
const cells = Array.from({ length: HEIGHT }, () => new Array(WIDTH).fill(BLACK));

const commands = ['push', 'out(char)', 'push', 'out(char)', 'push', 'out(char)'];
const colours = [{ hue: 0, shade: 1 }]; // B0: normal red
for (const c of commands) colours.push(after(colours.at(-1), c));

const sizes = [];
let x = 0;
widthOf.forEach((w, i) => {
  for (let dx = 0; dx < w; dx++) for (let y = 0; y < HEIGHT; y++) cells[y][x + dx] = colours[i];
  sizes.push(w * HEIGHT);
  x += w;
});
// B5: an L of three codels, (x,0) (x,1) (x+1,1). Its only way on is the codel (x+1,1).
cells[0][x] = colours[5];
cells[1][x] = colours[5];
cells[1][x + 1] = colours[5];
// B6: three codels tall, joined to B5 at its middle one.
for (let y = 0; y < 3; y++) cells[y][x + 2] = colours[6];

if (sizes[0] !== 70 || sizes[2] !== 84 || sizes[4] !== 70) {
  throw new Error(`unexpected block sizes ${sizes}`);
}

// ---------- pixels ----------

const width = WIDTH * CODEL;
const height = HEIGHT * CODEL;
const data = new Uint8Array(width * height * 3);
for (let py = 0; py < height; py++) {
  for (let px = 0; px < width; px++) {
    const cell = cells[Math.floor(py / CODEL)][Math.floor(px / CODEL)];
    const [r, g, b] = cell === BLACK ? [0, 0, 0] : rgb(cell);
    const o = (py * width + px) * 3;
    data[o] = r;
    data[o + 1] = g;
    data[o + 2] = b;
  }
}

const png = encode({ width, height, data, depth: 8, channels: 3 });
writeFileSync(new URL('esolang-piet-ftf.png', OUT), png);
console.log(
  `esolang-piet-ftf.png: ${width}x${height} px, ${WIDTH}x${HEIGHT} codels, ${png.length} bytes`,
);
