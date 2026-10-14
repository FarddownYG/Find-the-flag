// Generates the audio lab samples in public/samples/. Run: node scripts/gen-samples-audio-lab.mjs
//
// - audio-lab-voice.wav: a synthetic voice (espeak-ng) saying a neutral test phrase;
// - audio-lab-reversed-fast.wav: the same voice reversed and sped up x1.5 with its pitch, the
//   way a challenge author would do it (ffmpeg: areverse, asetrate x1.5, resample back);
// - audio-lab-stereo.wav: a hum on both channels, the voice only in the difference L - R.
//
// espeak-ng and ffmpeg are needed here only (dev time). The WAVs are committed, so the tests and
// the CI never run either tool. Same tool versions -> byte-identical files.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUT = new URL('../public/samples/', import.meta.url);
const PHRASE = 'find the flag, audio lab test';
const RATE = 22050;
const STEREO_RATE = 16000;
const SPEED = 1.5;

/** Mono or interleaved 16-bit samples of a PCM WAV. */
function readWav(bytes) {
  const b = Buffer.from(bytes);
  if (b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WAVE') {
    throw new Error('not a WAV file');
  }
  let p = 12;
  let fmt = null;
  while (p + 8 <= b.length) {
    const id = b.toString('latin1', p, p + 4);
    const size = b.readUInt32LE(p + 4);
    if (id === 'fmt ') {
      fmt = {
        channels: b.readUInt16LE(p + 10),
        rate: b.readUInt32LE(p + 12),
        bits: b.readUInt16LE(p + 22),
      };
    } else if (id === 'data') {
      if (!fmt || fmt.bits !== 16) throw new Error('expected 16-bit PCM');
      const end = Math.min(b.length, p + 8 + size);
      const samples = new Int16Array((end - p - 8) >> 1);
      for (let i = 0; i < samples.length; i++) samples[i] = b.readInt16LE(p + 8 + i * 2);
      return { ...fmt, samples };
    }
    p += 8 + size + (size & 1);
  }
  throw new Error('no data chunk');
}

/** 16-bit PCM WAV from float channels in [-1, 1] (interleaved when stereo). */
function wav16(channels, rate) {
  const n = channels[0].length;
  const nch = channels.length;
  const data = Buffer.alloc(n * nch * 2);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nch; c++) {
      const v = Math.max(-1, Math.min(1, channels[c][i]));
      data.writeInt16LE(
        Math.max(-32768, Math.min(32767, Math.round(v * 32768))),
        (i * nch + c) * 2,
      );
    }
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVEfmt ', 8, 'latin1');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(nch, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * nch * 2, 28);
  head.writeUInt16LE(nch * 2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36, 'latin1');
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

const toFloat = (int16) => Float32Array.from(int16, (v) => v / 32768);

function save(name, channels, rate) {
  const bytes = wav16(channels, rate);
  writeFileSync(new URL(name, OUT), bytes);
  const seconds = channels[0].length / rate;
  console.log(`${name}: ${(bytes.length / 1024).toFixed(1)} KiB, ${seconds.toFixed(3)} s`);
  return bytes;
}

function ffmpeg(input, output, filter) {
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    input,
    '-af',
    filter,
    '-fflags',
    '+bitexact',
    '-flags:a',
    '+bitexact',
    '-map_metadata',
    '-1',
    '-c:a',
    'pcm_s16le',
    output,
  ]);
  return readWav(readFileSync(output));
}

const tmp = mkdtempSync(join(tmpdir(), 'ftf-audio-lab-'));
try {
  // 1. The source voice, trimmed to the speech plus 80 ms of silence on each side.
  const raw = join(tmp, 'espeak.wav');
  execFileSync('espeak-ng', ['-v', 'en', '-s', '150', '-w', raw, PHRASE]);
  const spoken = readWav(readFileSync(raw));
  if (spoken.rate !== RATE || spoken.channels !== 1) throw new Error('unexpected espeak format');
  const loud = (v) => Math.abs(v) > 0.01 * 32768;
  const first = spoken.samples.findIndex(loud);
  const last = spoken.samples.findLastIndex(loud);
  const pad = Math.round(0.08 * RATE);
  const voice = toFloat(
    spoken.samples.subarray(
      Math.max(0, first - pad),
      Math.min(spoken.samples.length, last + pad + 1),
    ),
  );
  save('audio-lab-voice.wav', [voice], RATE);
  const voicePath = join(tmp, 'voice.wav');
  writeFileSync(voicePath, wav16([voice], RATE));

  // 2. The "challenge": reversed, then played 1.5 times faster (pitch up), back at 22050 Hz.
  const fast = ffmpeg(
    voicePath,
    join(tmp, 'fast.wav'),
    `areverse,asetrate=${RATE * SPEED},aresample=${RATE}`,
  );
  save('audio-lab-reversed-fast.wav', [toFloat(fast.samples)], RATE);

  // 3. Stereo: a hum in the middle (L + R), the voice only in the side (L - R).
  const v16 = toFloat(ffmpeg(voicePath, join(tmp, 'v16.wav'), `aresample=${STEREO_RATE}`).samples);
  const left = new Float32Array(v16.length);
  const right = new Float32Array(v16.length);
  for (let i = 0; i < v16.length; i++) {
    const t = i / STEREO_RATE;
    const hum =
      0.3 * Math.sin(2 * Math.PI * 110 * t) +
      0.15 * Math.sin(2 * Math.PI * 165 * t) +
      0.08 * Math.sin(2 * Math.PI * 220 * t);
    const side = 0.4 * v16[i];
    left[i] = hum + side;
    right[i] = hum - side;
  }
  save('audio-lab-stereo.wav', [left, right], STEREO_RATE);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
