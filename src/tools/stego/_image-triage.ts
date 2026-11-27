/**
 * "Look first" scorer for the image analysis tool: given a black and white bit plane, how much
 * does it look like it carries content rather than noise? Advisory numbers only; the caller turns
 * them into a candidate, never a confirmed finding.
 *
 * A low-bit plane of a natural photo is noise (compresses to ~100 %, neighbours agree half of the
 * time). A plane carrying text, a picture or a pattern compresses well, has long runs, and is not
 * a flat colour (a flat plane is just an untouched plane).
 */
import { deflateSync } from 'fflate';
import type { RgbaImage } from '../../core/types';
import { shannon } from '../forensics/entropy';
import { planeStats } from './_pixels';

export interface PlaneScore {
  /** Deflated size / raw size of the packed bits (about 1 for noise, near 0 for runs). */
  compression: number;
  /** Shannon entropy of the packed bytes, 0..8 bits per byte. */
  entropy: number;
  /** Neighbour agreement above the 0.5 noise baseline, rescaled 0..1 (horizontal and vertical). */
  autocorr: number;
  /** 0..1: high when the plane is not flat, compresses well and is spatially structured. */
  suspicion: number;
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Bits (0/1) of a plane: an RgbaImage whose red >= 128 means 1, or already-0/1 bytes. */
function bitsOf(plane: RgbaImage | Uint8Array, width: number, height: number): Uint8Array {
  const n = width * height;
  const bits = new Uint8Array(n);
  if (plane instanceof Uint8Array) {
    for (let i = 0; i < n; i++) bits[i] = plane[i] ? 1 : 0;
  } else {
    for (let i = 0; i < n; i++) bits[i] = plane.data[i * 4]! >= 128 ? 1 : 0;
  }
  return bits;
}

/** Pack rows of bits, 8 per byte, most significant first (each row padded to a byte). */
function pack(bits: Uint8Array, width: number, height: number): Uint8Array {
  const stride = Math.ceil(width / 8);
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (bits[y * width + x]) out[y * stride + (x >> 3)]! |= 0x80 >> (x & 7);
    }
  }
  return out;
}

export function scorePlane(
  plane: RgbaImage | Uint8Array,
  width: number,
  height: number,
): PlaneScore {
  if (width <= 0 || height <= 0) return { compression: 1, entropy: 0, autocorr: 0, suspicion: 0 };
  const bits = bitsOf(plane, width, height);
  const packed = pack(bits, width, height);
  const compression = deflateSync(packed, { level: 9 }).length / packed.length;
  const counts = new Uint32Array(256);
  for (let i = 0; i < packed.length; i++) counts[packed[i]!]!++;
  const entropy = shannon(counts, packed.length);

  // Horizontal agreement via the shared plane statistics (a bit plane image is 0 / 255 grey).
  const grey = new Uint8ClampedArray(width * height * 4);
  let ones = 0;
  for (let i = 0; i < bits.length; i++) {
    ones += bits[i]!;
    grey[i * 4] = bits[i]! * 255;
  }
  const horiz = planeStats({ width, height, data: grey }, 0, 7).agree;
  let same = 0;
  let pairs = 0;
  for (let y = 1; y < height; y++) {
    for (let x = 0; x < width; x++) {
      pairs++;
      if (bits[y * width + x] === bits[(y - 1) * width + x]) same++;
    }
  }
  const vert = pairs ? same / pairs : horiz;
  const autocorr = clamp01(((horiz + vert) / 2 - 0.5) * 2);

  // A flat plane (all 0 or all 1) carries nothing to look at; noise is balanced but unstructured.
  const p = ones / bits.length;
  const balance = clamp01(4 * p * (1 - p));
  const gain = clamp01(1 - compression);
  const suspicion = clamp01(Math.sqrt(gain * autocorr) * Math.sqrt(balance));
  return { compression, entropy, autocorr, suspicion };
}

/** Labelled images ranked from most to least suspicious (uses each image's red as the plane). */
export function rankSuspects(
  items: { label: string; image: RgbaImage }[],
): { label: string; score: number }[] {
  return items
    .map(({ label, image }) => ({
      label,
      score: scorePlane(image, image.width, image.height).suspicion,
    }))
    .sort((a, b) => b.score - a.score);
}
