// Synthetic samples for the "Printer tracking dots" tool. Deterministic: run it again and the bytes
// are identical. Nothing here is a real scan, a real printer, a real serial number or a real CTF
// challenge: the date, time and serial of each picture are made up and listed below.
//
//   node scripts/gen-samples-printer-dots.mjs
//
// Files:
//   printer-dots-synthetic.png  600x450 "scanned page": off-white paper with a faint gradient and
//                               mild noise, grey text-like strokes, and the Xerox DocuColor 15 x 8
//                               dot tile for 2024-11-05 14:37, serial 13572468, printed upside
//                               down (the tool must turn it 180°). Dots every 12 px (0.04 inch at
//                               300 dpi), only 30 levels darker than the paper in blue, red and
//                               green untouched. Tiles repeat over the page, staggered as DEDA
//                               describes the DocuColor layout (an 8 x 16 cell block, the copy in
//                               the next band shifted by 16 cells). The page is turned 2° clockwise.
//   printer-dots-corner.png     480x360 page of grey text with a single faint tile (18 levels of
//                               blue) in the top-right corner, for 1998-03-17 09:26, serial
//                               51300727 (year column 98: the century pivot reads it as 1998),
//                               pitch 12 px, turned 1.2° counter-clockwise, upright.
//   printer-dots-crop.png       304x192 tight crop of one tile for 2019-02-28 07:05, serial
//                               24681357: pitch 16 px, no rotation, upright, the top-left cell
//                               centred on (40, 40).
//
// The tile is built here from the EFF description (columns 2 minute, 5 hour, 6 day, 7 month,
// 8 year, 10 separator = all dots, 14-13-12-11 serial as two decimal digits each; rows 2-8 worth
// 64..1; row 1 and column 1 odd parity: every column, the parity column and its corner included,
// and every row but the top one holds an odd number of dots) — an independent port of what
// src/tools/stego/_docucolor.ts encodes. Uses only fast-png.
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

/** mulberry32: small seeded PRNG, floats in [0, 1). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- DocuColor tile (EFF numbering, 1-based columns) ----------

function encodeTile({ minute, hour, day, month, year, serial }) {
  const m = Array.from({ length: 8 }, () => Array(15).fill(false));
  const put = (col, v) => {
    for (let bit = 0; bit < 7; bit++) m[1 + bit][col - 1] = ((v >> (6 - bit)) & 1) === 1;
  };
  put(2, minute);
  put(5, hour);
  put(6, day);
  put(7, month);
  put(8, year % 100);
  put(10, 127);
  const digits = serial.padStart(8, '0');
  [14, 13, 12, 11].forEach((col, i) => put(col, Number(digits.slice(2 * i, 2 * i + 2))));
  // Odd parity: column 1 completes rows 2-8, row 1 completes every column (the corner included).
  for (let r = 1; r < 8; r++) m[r][0] = m[r].slice(1).filter(Boolean).length % 2 === 0;
  for (let c = 0; c < 15; c++) m[0][c] = m.slice(1).filter((row) => row[c]).length % 2 === 0;
  return m;
}

/** Mirror left-right (if asked), then turn clockwise: the same convention as the tool. */
function orient(m, { rotate, mirror }) {
  let out = mirror ? m.map((row) => [...row].reverse()) : m.map((row) => [...row]);
  for (let k = 0; k < rotate / 90; k++) {
    const h = out.length;
    const w = out[0].length;
    out = Array.from({ length: w }, (_, i) =>
      Array.from({ length: h }, (_, j) => out[h - 1 - j][i]),
    );
  }
  return out;
}

/**
 * Is there a dot at page cell (c, r)? Staggered tiling: bands of `short` cells across, each band
 * holding a tile then 17 empty cells along the long side; odd bands shifted by 16 cells.
 */
function tiledDot(pattern, c, r) {
  const ph = pattern.length;
  const pw = pattern[0].length;
  const wide = pw >= ph;
  const across = wide ? r : c;
  const along = wide ? c : r;
  const short = wide ? ph : pw;
  const long = wide ? pw : ph;
  const band = Math.floor(across / short);
  const a = ((across % short) + short) % short;
  const period = 2 * (long + 1);
  const b = (((along - (band & 1 ? long + 1 : 0)) % period) + period) % period;
  if (b >= long) return false;
  return wide ? pattern[a][b] : pattern[b][a];
}

/**
 * Render a page. Page frame: cell (c, r) has its centre at origin + (c, r) * pitch, then the whole
 * page is turned by `rotation` degrees (clockwise) around the image centre.
 */
function renderPage({ width, height, pitch, rotation, origin, dotAt, strokes, seed, depth = 30 }) {
  const rand = rng(seed);
  const data = new Uint8Array(width * height * 3);
  const th = (rotation * Math.PI) / 180;
  const cos = Math.cos(th);
  const sin = Math.sin(th);
  const cx = width / 2;
  const cy = height / 2;
  const radius = 0.25 * pitch;
  const toPage = (x, y) => {
    const dx = x - cx;
    const dy = y - cy;
    return [cx + dx * cos + dy * sin, cy - dx * sin + dy * cos];
  };
  // Strokes rasterised once in the page frame (grey level, 0 = paper).
  const mask = new Uint8Array(width * height);
  for (const s of strokes)
    for (let v = Math.max(0, s.y); v < Math.min(height, s.y + s.h); v++)
      for (let u = Math.max(0, s.x); u < Math.min(width, s.x + s.w); u++)
        mask[v * width + u] = Math.max(mask[v * width + u], s.grey);
  const SUB = [0.25, 0.75];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let dot = 0;
      let ink = 0;
      for (const sy of SUB) {
        for (const sx of SUB) {
          const [u, v] = toPage(x + sx, y + sy);
          const c = Math.round((u - origin[0]) / pitch);
          const r = Math.round((v - origin[1]) / pitch);
          if (dotAt(c, r)) {
            const d = Math.hypot(u - origin[0] - c * pitch, v - origin[1] - r * pitch);
            dot += Math.min(1, Math.max(0, radius - d + 0.5));
          }
          const mx = Math.floor(u);
          const my = Math.floor(v);
          if (mx >= 0 && my >= 0 && mx < width && my < height)
            ink = Math.max(ink, mask[my * width + mx]);
        }
      }
      dot /= 4;
      // Paper: a faint gradient, plus mild noise shared by the three channels.
      const n = rand();
      const noise = n < 0.02 ? -1 : n > 0.98 ? 1 : 0;
      const tone = Math.round(2 * (x / width) - 1) + noise;
      let red = 247 + tone;
      let green = 245 + tone;
      let blue = 239 + tone - Math.round(depth * dot);
      if (ink) {
        red = Math.round(red - (red - ink) * 0.95);
        green = Math.round(green - (green - ink) * 0.95);
        blue = Math.round(blue - (blue - ink) * 0.95);
      }
      const k = (y * width + x) * 3;
      data[k] = red;
      data[k + 1] = green;
      data[k + 2] = blue;
    }
  }
  return encode({ width, height, data, depth: 8, channels: 3 }, { zlib: { level: 9 } });
}

/** Grey bars laid out like lines of words (page frame). */
function textStrokes(seed, x0, y0, x1, y1) {
  const rand = rng(seed);
  const strokes = [];
  for (let y = y0; y < y1; y += 34) {
    let x = x0;
    while (x < x1) {
      const word = 18 + Math.floor(rand() * 60);
      if (x + word > x1) break;
      // A word: a 3-px stroke along its length and a few uprights, like letters.
      const grey = 70 + Math.floor(rand() * 40);
      strokes.push({ x, y: y + 12, w: word, h: 3, grey });
      for (let lx = x; lx < x + word - 3; lx += 7 + Math.floor(rand() * 5))
        strokes.push({ x: lx, y: y + 2 + Math.floor(rand() * 4), w: 3, h: 13, grey });
      x += word + 10 + Math.floor(rand() * 8);
    }
  }
  return strokes;
}

// ---------- printer-dots-synthetic.png ----------
{
  const tile = encodeTile({
    minute: 37,
    hour: 14,
    day: 5,
    month: 11,
    year: 2024,
    serial: '13572468',
  });
  const printed = orient(tile, { rotate: 180, mirror: false });
  write(
    'printer-dots-synthetic.png',
    renderPage({
      width: 600,
      height: 450,
      pitch: 12,
      rotation: 2,
      origin: [7, 9],
      dotAt: (c, r) => tiledDot(printed, c + 5, r + 3),
      strokes: textStrokes(11, 50, 170, 550, 420),
      seed: 2024,
    }),
  );
}

// ---------- printer-dots-corner.png ----------
{
  const tile = encodeTile({
    minute: 26,
    hour: 9,
    day: 17,
    month: 3,
    year: 1998,
    serial: '51300727',
  });
  write(
    'printer-dots-corner.png',
    renderPage({
      width: 480,
      height: 360,
      pitch: 12,
      rotation: -1.2,
      origin: [270, 30],
      dotAt: (c, r) => c >= 0 && r >= 0 && c < 15 && r < 8 && tile[r][c],
      strokes: textStrokes(7, 30, 150, 450, 340),
      seed: 1998,
      depth: 18,
    }),
  );
}

// ---------- printer-dots-crop.png ----------
{
  const tile = encodeTile({
    minute: 5,
    hour: 7,
    day: 28,
    month: 2,
    year: 2019,
    serial: '24681357',
  });
  write(
    'printer-dots-crop.png',
    renderPage({
      width: 304,
      height: 192,
      pitch: 16,
      rotation: 0,
      origin: [40, 40],
      dotAt: (c, r) => c >= 0 && r >= 0 && c < 15 && r < 8 && tile[r][c],
      strokes: [],
      seed: 2019,
    }),
  );
}
