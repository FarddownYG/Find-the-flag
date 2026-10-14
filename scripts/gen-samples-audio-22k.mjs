// Generates the 22050 Hz spectrogram samples in public/samples/. Deterministic.
//   audio-spectrogram-22k.wav   the neutral text "HELLO 7KHZ" drawn at 6000-8000 Hz, 22050 Hz mono
//   audio-spectrogram-22k.mp3   the same signal as a 22050 Hz MP3 (needs ffmpeg with libmp3lame)
// They exist to prove that the spectrogram uses the file's own sample rate and shows the whole
// 0 Hz to Nyquist (11025 Hz) band: the text must appear in the upper half of the picture.
// Run: node scripts/gen-samples-audio-22k.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const RATE = 22050;
const OUT = new URL('../public/samples/', import.meta.url);
const TEXT = 'HELLO 7KHZ';
const SLOT = 0.05; // seconds per picture column
const TOP_HZ = 8000; // frequency of the top row of the letters
const BOTTOM_HZ = 6000; // frequency of the bottom row
const AMP = 0.1;
const RAMP = 0.004;

/** 5x7 bitmap font, only the glyphs needed for the text. */
const FONT = {
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  7: ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
};

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

/** Raised-cosine gate: 0 outside [start, end], smooth ramps of `ramp` seconds inside. */
function gate(t, start, end, ramp) {
  if (t < start || t > end) return 0;
  const edge = Math.min(t - start, end - t);
  return edge >= ramp ? 1 : 0.5 - 0.5 * Math.cos((Math.PI * edge) / ramp);
}

function drawText(text) {
  const blank = () => Array(7).fill(false);
  const columns = [blank(), blank()];
  [...text].forEach((ch, i) => {
    const glyph = FONT[ch];
    if (!glyph) throw new Error(`No glyph for ${ch}`);
    if (i) columns.push(blank());
    for (let x = 0; x < 5; x++) columns.push(glyph.map((row) => row[x] === '#'));
  });
  columns.push(blank(), blank());

  const total = Math.round(columns.length * SLOT * RATE);
  const out = new Float64Array(total);
  const step = (TOP_HZ - BOTTOM_HZ) / 6;
  for (let row = 0; row < 7; row++) {
    const freq = TOP_HZ - row * step;
    // Consecutive lit columns of a row form one steady tone, so there are no clicks in a stroke.
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
  const rand = prng(22);
  return Array.from(out, (v) => {
    let s = 0;
    for (let i = 0; i < 6; i++) s += rand();
    return v + (s - 3) * Math.SQRT2 * 0.002;
  });
}

function wav16(samples) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => {
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), i * 2);
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

mkdirSync(OUT, { recursive: true });
const wavPath = fileURLToPath(new URL('audio-spectrogram-22k.wav', OUT));
const mp3Path = fileURLToPath(new URL('audio-spectrogram-22k.mp3', OUT));
const samples = drawText(TEXT);
writeFileSync(wavPath, wav16(samples));
console.log(`audio-spectrogram-22k.wav: ${(samples.length / RATE).toFixed(2)} s at ${RATE} Hz`);

try {
  // -bitexact keeps the encoder version and the date out of the file: same bytes on every run.
  execFileSync(
    'ffmpeg',
    [
      ...['-y', '-loglevel', 'error', '-i', wavPath, '-map_metadata', '-1'],
      ...['-fflags', '+bitexact', '-flags:a', '+bitexact'],
      ...['-ac', '1', '-ar', String(RATE), '-c:a', 'libmp3lame', '-b:a', '64k', mp3Path],
    ],
    { stdio: 'inherit' },
  );
  console.log('audio-spectrogram-22k.mp3: written with ffmpeg (libmp3lame, 64 kbit/s)');
} catch {
  console.warn(
    'ffmpeg with libmp3lame is not available: audio-spectrogram-22k.mp3 was not updated.',
  );
}
