// Generates the audio sample files in public/samples/. Deterministic, no dependencies.
// Run: node scripts/gen-samples-audio.mjs
import { mkdirSync, writeFileSync } from 'node:fs';

const RATE = 8000;
const OUT = new URL('../public/samples/', import.meta.url);

// ---------- helpers ----------

/** Small seeded PRNG (mulberry32) so the files are byte-identical on every run. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Roughly Gaussian noise (sum of uniforms), standard deviation `sigma`. */
function gaussian(rand, sigma) {
  let s = 0;
  for (let i = 0; i < 6; i++) s += rand();
  return (s - 3) * Math.SQRT2 * sigma;
}

/** Raised-cosine gate: 0 outside [start, end], smooth ramps of `ramp` seconds inside. */
function gate(t, start, end, ramp) {
  if (t < start || t > end) return 0;
  const edge = Math.min(t - start, end - t);
  return edge >= ramp ? 1 : 0.5 - 0.5 * Math.cos((Math.PI * edge) / ramp);
}

function wav16(samples) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => {
    const c = Math.max(-1, Math.min(1, v));
    data.writeInt16LE(Math.round(c * 32767), i * 2);
  });
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // mono
  head.writeUInt32LE(RATE, 24);
  head.writeUInt32LE(RATE * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

function save(name, samples) {
  const bytes = wav16(samples);
  writeFileSync(new URL(name, OUT), bytes);
  console.log(
    `${name}: ${(bytes.length / 1024).toFixed(1)} KiB, ${(samples.length / RATE).toFixed(2)} s`,
  );
}

mkdirSync(OUT, { recursive: true });

// ---------- 1. text drawn in the spectrogram ----------

// 5x7 bitmap font, only the glyphs needed for FLAG{SPECTRO}.
const FONT = {
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.###.'],
  '{': ['..##.', '.#...', '.#...', '##...', '.#...', '.#...', '..##.'],
  '}': ['.##..', '...#.', '...#.', '...##', '...#.', '...#.', '.##..'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
};

function spectrogramText(text) {
  // Column map: one array of 7 booleans per time slot (top row first), 1 blank column between letters.
  const blank = () => Array(7).fill(false);
  const columns = [blank(), blank()];
  [...text].forEach((ch, i) => {
    const glyph = FONT[ch];
    if (!glyph) throw new Error(`No glyph for ${ch}`);
    if (i) columns.push(blank());
    for (let x = 0; x < 5; x++) columns.push(glyph.map((row) => row[x] === '#'));
  });
  columns.push(blank(), blank());

  const SLOT = 0.09; // seconds per picture column
  const TOP_HZ = 1750;
  const STEP_HZ = 75; // one picture row = 75 Hz, row 0 on top
  const AMP = 0.12;
  const RAMP = 0.008;
  const total = Math.round(columns.length * SLOT * RATE);
  const out = new Float64Array(total);
  for (let row = 0; row < 7; row++) {
    const freq = TOP_HZ - row * STEP_HZ;
    // Consecutive lit columns in a row form one steady tone, so no clicks inside a stroke.
    let x = 0;
    while (x < columns.length) {
      if (!columns[x][row]) {
        x++;
        continue;
      }
      let y = x;
      while (y < columns.length && columns[y][row]) y++;
      const start = x * SLOT;
      const end = y * SLOT;
      for (let i = Math.floor(start * RATE); i < Math.min(total, Math.ceil(end * RATE)); i++) {
        const t = i / RATE;
        out[i] += AMP * gate(t, start, end, RAMP) * Math.sin(2 * Math.PI * freq * t);
      }
      x = y;
    }
  }
  const rand = prng(1);
  return Array.from(out, (v) => v + gaussian(rand, 0.002));
}

save('audio-spectrogram.wav', spectrogramText('FLAG{SPECTRO}'));

// ---------- 2. DTMF ----------

const DTMF_ROWS = [697, 770, 852, 941];
const DTMF_COLS = [1209, 1336, 1477, 1633];
const KEYPAD = ['123A', '456B', '789C', '*0#D'];

function dtmf(keys) {
  const TONE = 0.12;
  const GAP = 0.08;
  const LEAD = 0.25;
  const total = Math.round((LEAD * 2 + keys.length * (TONE + GAP)) * RATE);
  const out = new Float64Array(total);
  [...keys].forEach((key, n) => {
    const r = KEYPAD.findIndex((line) => line.includes(key));
    const c = KEYPAD[r].indexOf(key);
    const start = LEAD + n * (TONE + GAP);
    const end = start + TONE;
    for (let i = Math.floor(start * RATE); i < Math.ceil(end * RATE); i++) {
      const t = i / RATE;
      const g = gate(t, start, end, 0.003);
      out[i] +=
        g *
        (0.4 * Math.sin(2 * Math.PI * DTMF_ROWS[r] * t) +
          0.35 * Math.sin(2 * Math.PI * DTMF_COLS[c] * t));
    }
  });
  const rand = prng(2);
  return Array.from(out, (v) => v + gaussian(rand, 0.01));
}

save('audio-dtmf.wav', dtmf('0123456789*#'));

// ---------- 3. Morse ----------

const MORSE = {
  A: '.-',
  C: '-.-.',
  E: '.',
  F: '..-.',
  G: '--.',
  I: '..',
  L: '.-..',
  M: '--',
  O: '---',
  R: '.-.',
  S: '...',
};

function morse(text, wpm, tone) {
  const unit = 1.2 / wpm;
  // Build the on/off timeline in units: [on?, units]
  const timeline = [];
  const words = text.split(' ');
  words.forEach((word, wi) => {
    if (wi) timeline.push([false, 7]);
    [...word].forEach((letter, li) => {
      if (li) timeline.push([false, 3]);
      [...MORSE[letter]].forEach((sym, si) => {
        if (si) timeline.push([false, 1]);
        timeline.push([true, sym === '.' ? 1 : 3]);
      });
    });
  });
  const LEAD = 0.5;
  const length = timeline.reduce((a, [, u]) => a + u, 0) * unit;
  const total = Math.round((LEAD * 2 + length) * RATE);
  const out = new Float64Array(total);
  let at = LEAD;
  for (const [on, units] of timeline) {
    const end = at + units * unit;
    if (on) {
      for (let i = Math.floor(at * RATE); i < Math.ceil(end * RATE); i++) {
        const t = i / RATE;
        out[i] += 0.5 * gate(t, at, end, 0.005) * Math.sin(2 * Math.PI * tone * t);
      }
    }
    at = end;
  }
  const rand = prng(3);
  return Array.from(out, (v) => v + gaussian(rand, 0.02));
}

save('audio-morse.wav', morse('FLAG IS MORSE', 15, 700));
