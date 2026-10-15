/**
 * VIS header search. A transmission starts with: 300 ms of 1900 Hz, a 10 ms 1200 Hz break,
 * 300 ms of 1900 Hz, then ten 30 ms slots: a 1200 Hz start bit, seven data bits (1100 Hz = 1,
 * 1300 Hz = 0, least significant first), an even-parity bit and a 1200 Hz stop bit. The picture
 * starts right after the stop bit. The search looks for "1900 Hz leader, then a 30 ms 1200 Hz
 * start bit" on a 1 ms grid, then reads the ten slots relative to the measured 1200 Hz tone, so
 * a tuning offset or a slightly wrong sample-rate label does not matter.
 */
import { endTime, toneAt, type Demod } from './_sstv-demod';
import { FREQ_SYNC, modeByVis } from './_sstv-modes';
import { refineSync } from './_sstv-sync';

export interface VisHit {
  /** Start of the start bit, seconds. */
  start: number;
  /** 7-bit code read from the data bits. */
  code: number;
  parityOk: boolean;
  /** Time scale of the recording against the standard (1 = nominal, 1.01 = 1 % too slow). */
  scale: number;
  /** Observed frequency of the leader (nominal 1900 Hz) and of the 1200 Hz bits. */
  leaderHz: number;
  lowHz: number;
  /** Where the picture starts, seconds. */
  imageStart: number;
  /** 0..1, the weakest bit of the header. */
  confidence: number;
}

interface Read {
  code: number;
  parityOk: boolean;
  lowHz: number;
  margin: number;
}

/** Read the ten slots of a header whose start bit begins at `u`, at time scale `s`. */
function readSlots(d: Demod, u: number, s: number): Read | null {
  const slot = 0.03 * s;
  const mid = (j: number) => u + slot * (j + 0.5);
  const half = 0.008 * s;
  const start = toneAt(d, mid(0) - half, mid(0) + half);
  if (start.coherence < 0.5) return null;
  const lowHz = start.freq;
  // The standard's 100 Hz between a bit and the 1200 Hz tone, as observed in this recording.
  const unit = 100 / s;
  let margin = 1;
  let code = 0;
  let ones = 0;
  for (let j = 1; j <= 8; j++) {
    const t = toneAt(d, mid(j) - half, mid(j) + half);
    if (t.coherence < 0.5) return null;
    const diff = t.freq - lowHz;
    if (Math.abs(diff) < 0.4 * unit || Math.abs(diff) > 2.2 * unit) return null;
    margin = Math.min(margin, Math.min(1, Math.abs(diff) / unit) * 0.5 + 0.5 * t.coherence);
    const bit = diff < 0 ? 1 : 0;
    ones += bit;
    if (j <= 7) code |= bit << (j - 1);
  }
  const stop = toneAt(d, mid(9) - half, mid(9) + half);
  if (stop.coherence < 0.5 || Math.abs(stop.freq - lowHz) > 0.55 * unit) return null;
  margin = Math.min(margin, 1 - Math.abs(stop.freq - lowHz) / unit);
  return { code, parityOk: ones % 2 === 0, lowHz, margin };
}

/** The best reading of a header near `u0` (start-bit edge guessed within a few ms). */
function readHeader(d: Demod, u0: number): VisHit | null {
  const lead = toneAt(d, u0 - 0.24, u0 - 0.02);
  const low = toneAt(d, u0 + 0.006, u0 + 0.024);
  // Nominal timing first; then the timing the recording itself shows. A wrong sample-rate label
  // stretches the whole header and moves every tone by the same ratio: the 10 ms break sits
  // 305 ms before the start bit (time), and the leader and the 1200 Hz tone are 700 Hz apart
  // (frequency). Noise squeezes tones towards the middle of the band, so the frequency reading
  // is only trusted where the timing agrees with it.
  const scales = [1];
  const brk = refineSync(d, u0 - 0.305, 10, low.freq, 0.05);
  if (brk) {
    const byTime = (u0 - brk.time) / 0.305;
    const gap = lead.freq - low.freq;
    const byFreq = gap > 300 ? 700 / gap : 0;
    const s = Math.abs(byFreq - byTime) < 0.015 ? byFreq : byTime;
    if (s > 0.85 && s < 1.15 && Math.abs(s - 1) > 0.006) scales.push(s);
  }
  let best: VisHit | null = null;
  // The edge guess first, then up to 4 ms either side of it.
  for (const du of [0, -0.001, 0.001, -0.002, 0.002, -0.003, 0.003, -0.004, 0.004]) {
    const u = u0 + du;
    for (const s of scales) {
      const read = readSlots(d, u, s);
      if (!read || (!read.parityOk && !modeByVis(read.code))) continue;
      const confidence = read.margin * (read.parityOk ? 1 : 0.6);
      if (!best || confidence > best.confidence + 0.02) {
        best = {
          start: u,
          code: read.code,
          parityOk: read.parityOk,
          scale: s,
          leaderHz: toneAt(d, u - 0.26 * s, u - 0.02 * s).freq,
          lowHz: read.lowHz,
          imageStart: u + 0.3 * s,
          confidence,
        };
      }
    }
  }
  return best;
}

/** Move a rough edge guess to where the frequency drops most sharply (leader -> start bit). */
function sharpestEdge(d: Demod, guess: number): number {
  const times: number[] = [];
  const drops: number[] = [];
  for (let u = guess - 0.025; u <= guess + 0.0251; u += 0.0005) {
    times.push(u);
    drops.push(toneAt(d, u - 0.012, u - 0.001).freq - toneAt(d, u + 0.001, u + 0.012).freq);
  }
  // The drop is flat-topped (both windows are pure tone for a couple of ms around the edge):
  // the middle of the top is the edge.
  const top = Math.max(...drops);
  let sum = 0;
  let n = 0;
  drops.forEach((v, i) => {
    if (v >= 0.97 * top) {
      sum += times[i]!;
      n++;
    }
  });
  return n ? sum / n : guess;
}

/** Candidate edges examined at most (a real recording has a handful of headers). */
const MAX_CANDIDATES = 300;

/** Every VIS header in the demodulated stretch, in time order. */
export function findVisHeaders(d: Demod): VisHit[] {
  const edges: number[] = [];
  const last = endTime(d) - 0.31;
  for (let u = d.t0 + 0.1; u < last; u += 0.001) {
    const lead = toneAt(d, u - 0.1, u - 0.004);
    if (lead.coherence < 0.5 || lead.freq < 1620 || lead.freq > 2180) continue;
    const low = toneAt(d, u + 0.004, u + 0.026);
    if (low.coherence < 0.5 || low.freq < FREQ_SYNC - 190 || low.freq > FREQ_SYNC + 190) continue;
    edges.push(u);
  }
  const hits: VisHit[] = [];
  let tried = 0;
  for (let i = 0; i < edges.length && tried < MAX_CANDIDATES;) {
    let j = i;
    while (j + 1 < edges.length && edges[j + 1]! - edges[j]! < 0.008) j++;
    const centre = (edges[i]! + edges[j]!) / 2;
    i = j + 1;
    tried++;
    const hit = readHeader(d, sharpestEdge(d, centre));
    if (!hit) continue;
    const prev = hits[hits.length - 1];
    if (prev && hit.start - prev.start < 1) {
      if (hit.confidence > prev.confidence) hits[hits.length - 1] = hit;
    } else hits.push(hit);
  }
  return hits;
}
