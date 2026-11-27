/**
 * "Look first" decisions of the image lab. The scorer (_image-triage) is not bit-depth aware, so
 * only the lowest bit planes are scored: a high plane of a photo is the picture itself, and it
 * would read as "structured". On top of the score, a plane is suspect only when it stands out
 * from the other planes of the same image (a smooth gradient has structure in every plane, which
 * says nothing), and a colour remap is suspect only when the image really has two colours that
 * differ by a hair.
 */
import type { RgbaImage } from '../../core/types';
import { scorePlane } from './_image-triage';

/** A plane is suspect from this score... */
export const SUSPECT_MIN = 0.35;
/** ...when it also beats the median score of the scored planes by this much. */
export const SUSPECT_GAP = 0.2;
export const MAX_SUSPECTS = 6;
/** Planes below this bit are scored (bits 0-3); the rest are image content. */
export const LOW_BITS = 4;

export interface Scored {
  id: string;
  score: number;
}

/** The ids worth a look, best first: above the floor, standing out from the median. */
export function pickSuspects(scored: Scored[]): Scored[] {
  if (!scored.length) return [];
  const sorted = scored.map((s) => s.score).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  return scored
    .filter((s) => s.score >= SUSPECT_MIN && s.score - median >= SUSPECT_GAP)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SUSPECTS);
}

/**
 * What a smooth picture would hold at every pixel of one channel: the rounded mean of its four
 * neighbours (border pixels keep their own value and are not judged).
 */
export function neighbourPrediction(img: RgbaImage, channel: number): Uint8Array {
  const { width: w, height: h, data } = img;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const edge = x === 0 || y === 0 || x === w - 1 || y === h - 1;
      out[i] = edge
        ? data[i * 4 + channel]!
        : Math.round(
            (data[(i - 1) * 4 + channel]! +
              data[(i + 1) * 4 + channel]! +
              data[(i - w) * 4 + channel]! +
              data[(i + w) * 4 + channel]!) /
              4,
          );
    }
  }
  return out;
}

/**
 * How much of a bit plane is just the picture: the share of the plane's minority-value pixels
 * that the neighbour prediction gets right. A smooth gradient bands every plane the same way a
 * message would, but its bands follow the picture (about 1); a message does not (about 0.5 or
 * less). Judging the minority pixels keeps a large flat background from vouching for the text.
 */
export function explainedShare(
  img: RgbaImage,
  channel: number,
  bit: number,
  prediction: Uint8Array,
): number {
  const { width: w, height: h, data } = img;
  let ones = 0;
  let total = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      ones += (data[(y * w + x) * 4 + channel]! >> bit) & 1;
      total++;
    }
  }
  if (!total || ones === 0 || ones === total) return 0;
  const minority = ones * 2 <= total ? 1 : 0;
  let seen = 0;
  let right = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (((data[i * 4 + channel]! >> bit) & 1) !== minority) continue;
      seen++;
      if (((prediction[i]! >> bit) & 1) === minority) right++;
    }
  }
  return seen ? right / seen : 0;
}

/**
 * The scorer's number for a plane picture, discounted by how much of the plane the picture
 * itself explains (see explainedShare).
 */
export function planeScore(plane: RgbaImage, explained = 0): number {
  const raw = scorePlane(plane, plane.width, plane.height).suspicion;
  return raw * (1 - Math.min(1, Math.max(0, (explained - 0.5) * 2)));
}

/** Beyond this many distinct colours the image is a photo or a render: no remap triage. */
const FEW_COLOURS = 32;
/** Two colours this close (largest channel gap) read as "the same colour" to the eye. */
const NEAR = 3;
/** The near colour's mask must look like content this much (shading and gradients do not). */
const MIN_STRUCTURE = 0.4;

export interface NearColours {
  /** The dominant colour and the near one hiding in it, as [r, g, b]. */
  base: [number, number, number];
  near: [number, number, number];
  /** Largest channel difference between them. */
  gap: number;
  /** Share of pixels with the near colour. */
  share: number;
  /** How much the near colour's mask looks like content (0..1, from the plane scorer). */
  structure: number;
}

const unpack = (k: number): [number, number, number] => [(k >> 16) & 255, (k >> 8) & 255, k & 255];

/**
 * Does a few-colour image hide a shape in a colour almost equal to the background? Returns the
 * pair of colours when a minority colour within NEAR of another covers 0.1 % to 50 % of the
 * pixels and is spatially structured. Photos (many colours) return null at once.
 */
export function findNearColours(img: RgbaImage): NearColours | null {
  const n = img.width * img.height;
  const counts = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const k = (img.data[i * 4]! << 16) | (img.data[i * 4 + 1]! << 8) | img.data[i * 4 + 2]!;
    counts.set(k, (counts.get(k) ?? 0) + 1);
    if (counts.size > FEW_COLOURS) return null;
  }
  if (counts.size < 2) return null;
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const [baseKey] = ranked[0]!;
  const base = unpack(baseKey);
  let best: NearColours | null = null;
  for (const [key, count] of ranked.slice(1)) {
    const near = unpack(key);
    const gap = Math.max(...near.map((v, c) => Math.abs(v - base[c]!)));
    const share = count / n;
    if (gap > NEAR || share < 0.001 || share > 0.5) continue;
    const mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const k = (img.data[i * 4]! << 16) | (img.data[i * 4 + 1]! << 8) | img.data[i * 4 + 2]!;
      mask[i] = k === key ? 1 : 0;
    }
    const structure = scorePlane(mask, img.width, img.height).suspicion;
    if (structure < MIN_STRUCTURE) continue;
    if (!best || structure > best.structure) best = { base, near, gap, share, structure };
  }
  return best;
}
