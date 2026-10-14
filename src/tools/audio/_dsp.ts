/** Small signal-processing helpers shared by the audio tools. */

/** Average all channels into one. */
export function mixToMono(channels: Float32Array[]): Float32Array {
  const first = channels[0];
  if (!first) return new Float32Array(0);
  if (channels.length === 1) return first;
  const out = new Float32Array(first.length);
  for (const ch of channels) for (let i = 0; i < out.length; i++) out[i] = out[i]! + (ch[i] ?? 0);
  const k = 1 / channels.length;
  for (let i = 0; i < out.length; i++) out[i] = out[i]! * k;
  return out;
}

export function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Value at quantile q in [0, 1] (nearest rank). */
export function quantile(values: readonly number[], q: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)))]!;
}

export interface Clusters {
  /** Ascending. */
  centers: number[];
  /** Cluster index of every input value. */
  labels: number[];
  counts: number[];
}

/** 1-D k-means with quantile initialisation; clusters come back sorted by centre. */
export function kmeans1d(values: readonly number[], k: number): Clusters {
  const n = values.length;
  const sorted = [...values].sort((a, b) => a - b);
  const kk = Math.max(1, Math.min(k, n));
  let centers = Array.from(
    { length: kk },
    (_, i) => sorted[Math.min(n - 1, Math.floor(((i + 0.5) / kk) * n))] ?? 0,
  );
  let labels = new Array<number>(n).fill(0);
  for (let iter = 0; iter < 100; iter++) {
    const sums = new Array<number>(kk).fill(0);
    const cnt = new Array<number>(kk).fill(0);
    let changed = false;
    for (let i = 0; i < n; i++) {
      const v = values[i]!;
      let best = 0;
      let bd = Infinity;
      for (let c = 0; c < kk; c++) {
        const d = Math.abs(v - centers[c]!);
        if (d < bd) {
          bd = d;
          best = c;
        }
      }
      if (labels[i] !== best) changed = true;
      labels[i] = best;
      sums[best] = sums[best]! + v;
      cnt[best] = cnt[best]! + 1;
    }
    centers = centers.map((c, i) => (cnt[i]! > 0 ? sums[i]! / cnt[i]! : c));
    if (!changed && iter > 0) break;
  }
  // Renumber so that cluster 0 has the smallest centre.
  const order = centers.map((c, i) => [c, i] as const).sort((a, b) => a[0] - b[0]);
  const rank = new Array<number>(kk).fill(0);
  order.forEach(([, old], r) => (rank[old] = r));
  labels = labels.map((l) => rank[l]!);
  const outCenters = order.map(([c]) => c);
  const counts = new Array<number>(kk).fill(0);
  for (const l of labels) counts[l] = counts[l]! + 1;
  return { centers: outCenters, labels, counts };
}

/** Round to a given number of decimals, returned as a number. */
export function round(v: number, decimals = 1): number {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}
