/**
 * Sync pulse tracking. Every line (or pair of lines, in PD) starts, or is marked, by a 1200 Hz
 * pulse: video is never below 1500 Hz, so a pulse is the only "low" stretch in the picture.
 *
 *  1. findSyncPulses: a coarse scan for stretches of low frequency (any mode).
 *  2. findProgression: the pulses form an arithmetic progression (one per line time); find the
 *     longest one that fits, tolerating missed and false pulses.
 *  3. refineSync: once the mode (hence the pulse length) is known, locate each pulse precisely
 *     by correlating the "low / not low" track with an ideal pulse.
 */
import { endTime, toneAt, type Demod } from './_sstv-demod';

export interface SyncPulse {
  /** Middle of the pulse, seconds. */
  time: number;
  /** Length, ms. */
  width: number;
  strength: number;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 1 for a sync tone (about `lowHz`), 0 for anything from black (+300 Hz) upwards. */
export const lowness = (freq: number, lowHz: number): number => clamp01((lowHz + 250 - freq) / 200);

/** Coarse scan: pulses of low frequency between t0 and t1, 2.5 to 32 ms long. */
export function findSyncPulses(d: Demod, t0: number, t1: number, lowHz: number): SyncPulse[] {
  const hop = 0.0005;
  const win = 0.002;
  const from = Math.max(d.t0, t0);
  const to = Math.min(endTime(d), t1);
  const cells = Math.max(0, Math.floor((to - from - win) / hop));
  const w = new Float32Array(cells);
  for (let k = 0; k < cells; k++) {
    const a = from + k * hop;
    const tone = toneAt(d, a, a + win);
    w[k] = lowness(tone.freq, lowHz);
  }
  const pulses: SyncPulse[] = [];
  for (let k = 0; k < cells;) {
    if (w[k]! < 0.5) {
      k++;
      continue;
    }
    let end = k;
    while (end + 1 < cells && w[end + 1]! >= 0.5) end++;
    let sum = 0;
    let moment = 0;
    for (let i = Math.max(0, k - 3); i <= Math.min(cells - 1, end + 3); i++) {
      sum += w[i]!;
      moment += w[i]! * (from + i * hop + win / 2);
    }
    const width = sum * hop * 1000;
    if (width >= 2.5 && width <= 32) {
      pulses.push({ time: moment / sum, width, strength: Math.min(1, sum / (end - k + 1)) });
    }
    k = end + 1;
  }
  return pulses;
}

export interface Progression {
  /** Indices into the pulse list, ascending, and each member's line number in the chain. */
  members: number[];
  lines: number[];
}

/** Index of the pulse closest to `time` (array sorted by time), or -1 within `tol`. */
function nearest(times: readonly number[], time: number, tol: number): number {
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! < time) lo = mid + 1;
    else hi = mid;
  }
  let best = -1;
  let dist = tol;
  for (const i of [lo - 1, lo, lo + 1]) {
    if (i < 0 || i >= times.length) continue;
    const dd = Math.abs(times[i]! - time);
    if (dd <= dist) {
      dist = dd;
      best = i;
    }
  }
  return best;
}

/** Most pulses considered at once (the strongest ones): bounds the work on pathological input. */
const MAX_PULSES = 3000;
/** Budget of prediction steps over all the chains grown. */
const MAX_STEPS = 3_000_000;

/**
 * The longest chain of pulses spaced `period` apart (tMin <= period <= tMax seconds), grown from
 * plausible pairs of neighbours: predict the next pulse, take the nearest one within a couple of
 * ms, refit, and carry on through gaps of up to `maxMiss` missing pulses. A pulse that is part of
 * a chain of four or more is not used as a seed again, so a regular train of pulses (or of
 * noise) is grown once, not once per pair.
 */
export function findProgression(
  all: readonly SyncPulse[],
  tMin: number,
  tMax: number,
  maxMiss = 10,
): Progression | null {
  // Index lists: `order` maps the considered pulses (time order) back to `all`.
  let order = all.map((_, i) => i);
  if (order.length > MAX_PULSES) {
    order = order
      .sort((x, y) => all[y]!.strength - all[x]!.strength)
      .slice(0, MAX_PULSES)
      .sort((x, y) => x - y);
  }
  const pulses = order.map((i) => all[i]!);
  const times = pulses.map((p) => p.time);
  let best: { members: number[]; lines: number[]; score: number } | null = null;
  const claimed = new Set<number>();
  let steps = 0;

  const grow = (i: number, j: number) => {
    // Running sums of the least-squares line t = a + period * n through the members so far.
    let count = 2;
    let sn = 1;
    let st = times[i]! + times[j]!;
    let snn = 1;
    let snt = times[j]!;
    const model = () => {
      const den = count * snn - sn * sn;
      const period = den === 0 ? 0 : (count * snt - sn * st) / den;
      return { a: (st - period * sn) / count, period };
    };
    const add = (n: number, t: number) => {
      count++;
      sn += n;
      st += t;
      snn += n * n;
      snt += n * t;
    };
    const ahead: number[] = [];
    const aheadLines: number[] = [];
    const behind: number[] = [];
    const behindLines: number[] = [];
    const extend = (dir: 1 | -1) => {
      let n = dir === 1 ? 2 : -1;
      let edge = dir === 1 ? j : i;
      let miss = 0;
      while (miss <= maxMiss && steps++ < MAX_STEPS) {
        const fit = model();
        const tol = Math.min(0.006, (count < 5 ? 0.003 : 0.002) + 0.0007 * miss);
        const at = nearest(times, fit.a + fit.period * n, tol);
        if (at >= 0 && (dir === 1 ? at > edge : at < edge)) {
          (dir === 1 ? ahead : behind).push(at);
          (dir === 1 ? aheadLines : behindLines).push(n);
          add(n, times[at]!);
          edge = at;
          miss = 0;
        } else miss++;
        n += dir;
      }
    };
    extend(1);
    extend(-1);
    const members = [...behind.reverse(), i, j, ...ahead];
    const lines = [...behindLines.reverse(), 0, 1, ...aheadLines];
    if (members.length >= 4) for (const m of members) claimed.add(m);
    const score = members.reduce((sum, m) => sum + 0.5 + 0.5 * pulses[m]!.strength, 0);
    if (!best || score > best.score) best = { members, lines, score };
  };

  for (let i = 0; i < times.length && steps < MAX_STEPS; i++) {
    for (let j = i + 1; j < times.length; j++) {
      const dt = times[j]! - times[i]!;
      if (dt > tMax) break;
      if (dt < tMin || (claimed.has(i) && claimed.has(j))) continue;
      grow(i, j);
    }
  }
  const found = best as { members: number[]; lines: number[] } | null;
  if (!found || found.members.length < 3) return null;
  return { members: found.members.map((m) => order[m]!), lines: found.lines };
}

/** A located pulse weaker than this (1 = ideal) is not counted as found. */
export const MIN_STRENGTH = 0.4;

export interface RefinedSync {
  /** Middle of the pulse, seconds. */
  time: number;
  /** 0..1, how well the pulse matches an ideal one. */
  strength: number;
}

/**
 * Locate the sync pulse expected around `centre` (+- `range` s). The track of "low frequency or
 * not" is correlated with an ideal pulse of `syncMs` ms: the mean over the pulse minus the mean
 * over 3 ms either side of it, which peaks at the pulse and is zero for a flat track (noise).
 * Strength is 1 for a perfect pulse; the position is the middle of the top of the peak. Windows
 * quieter than `powerFloor` (silence between transmissions) count as neither.
 */
export function refineSync(
  d: Demod,
  centre: number,
  syncMs: number,
  lowHz: number,
  range = 0.0035,
  powerFloor = 0,
): RefinedSync | null {
  const half = syncMs / 2000;
  const flank = 0.003;
  const span = range + half + flank;
  const step = 1 / d.rate;
  const first = centre - span;
  const count = Math.floor((2 * span) / step);
  const g = new Float32Array(count);
  for (let j = 0; j < count; j++) {
    const a = first + j * step;
    const tone = toneAt(d, a - step, a + 2 * step);
    // Where there is hardly any signal, the frequency is noise: neither low nor high.
    g[j] = tone.power < powerFloor ? 0 : 2 * lowness(tone.freq, lowHz) - 1;
  }
  const shifts = Math.round(range / (step / 2));
  const scores = new Float64Array(2 * shifts + 1);
  let bestAt = 0;
  for (let s = -shifts; s <= shifts; s++) {
    const c = centre + (s * step) / 2;
    const lo = Math.max(0, Math.floor((c - half - flank - first) / step));
    const hi = Math.min(count - 1, Math.ceil((c + half + flank - first) / step));
    let inside = 0;
    let outside = 0;
    let nIn = 0;
    let nOut = 0;
    for (let j = lo; j <= hi; j++) {
      if (Math.abs(first + j * step - c) <= half) {
        inside += g[j]!;
        nIn++;
      } else {
        outside += g[j]!;
        nOut++;
      }
    }
    scores[s + shifts] = nIn && nOut ? (inside / nIn - outside / nOut) / 2 : 0;
    if (scores[s + shifts]! > scores[bestAt]!) bestAt = s + shifts;
  }
  const peak = scores[bestAt]!;
  if (peak < MIN_STRENGTH) return null;
  // The top is flat to within noise: take the middle of the shifts within 5% of the peak.
  let sum = 0;
  let n = 0;
  for (let i = 0; i < scores.length; i++) {
    if (scores[i]! >= peak - 0.05 * peak) {
      sum += i;
      n++;
    }
  }
  return { time: centre + ((sum / n - shifts) * step) / 2, strength: Math.min(1, peak) };
}
