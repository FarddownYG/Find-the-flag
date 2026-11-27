/**
 * The pictures of the image lab: bit planes, superimposed planes, colour remaps and filters, with
 * the "look first" triage. Pure (pixels in, labelled pictures out); every word goes through the
 * image-lab and bit-planes text keys.
 *
 * Superimposed planes are not scored: OR and AND of noisy planes are biased noise, which the
 * scorer reads as structure, and XOR of noise is noise. They stay in the gallery to browse.
 *
 * Memory: the gallery crosses the worker boundary by structured clone, so each picture is made at
 * the smallest size that is still useful. Suspects get the full working size, the low bit planes
 * (where a message hides) and the colour remaps a middle size, everything else a thumbnail size.
 */
import type { GalleryItem, RgbaImage } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import {
  channelDiff,
  gammaImage,
  rgbReduce,
  sobel,
  stretchImage,
  superimposePlane,
} from './_image-ops';
import {
  explainedShare,
  findNearColours,
  LOW_BITS,
  neighbourPrediction,
  type NearColours,
  pickSuspects,
  planeScore,
  type Scored,
} from './_image-lab-triage';
import {
  bitPlaneImage,
  channelImage,
  equalize,
  fitPixels,
  hasAlpha,
  mapRgb,
  randomColormap,
} from './_pixels';
import { CHANNELS, planeName } from './bit-planes';

const T = toolT('image-lab');
const TB = toolT('bit-planes');

/** Pixels of a picture by tier: the low planes and remaps, then everything else. */
export const MID_PIXELS = 250_000;
export const SMALL_PIXELS = 90_000;
/** The whole-pixel colour map keeps one colour per distinct value: only for few-colour images. */
const REMAP_MAX_COLOURS = 65_536;

export interface Visuals {
  groups: { title: string; items: GalleryItem[] }[];
  /** Ids to open first, best first. */
  lookFirst: string[];
  /** Why each suspect is one: [picture label, sentence]. */
  reasons: [string, string][];
  near: NearColours | null;
  /** How many low planes the triage scored. */
  scored: number;
}

const MODES = ['or', 'and', 'xor'] as const;
const hex = (c: readonly number[]) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;

/** Distinct colours of an image, counting stops at `cap`. */
function colourCount(img: RgbaImage, cap: number): number {
  const seen = new Set<number>();
  for (let i = 0; i < img.width * img.height; i++) {
    seen.add((img.data[i * 4]! << 16) | (img.data[i * 4 + 1]! << 8) | img.data[i * 4 + 2]!);
    if (seen.size > cap) break;
  }
  return seen.size;
}

/** Triage scores of bits 0-3 of each channel: the scorer's number, discounted when explained. */
export function scoreLowPlanes(
  work: RgbaImage,
  channels: readonly { id: string; index: number }[],
): Scored[] {
  const scored: Scored[] = [];
  for (const ch of channels) {
    const prediction = neighbourPrediction(work, ch.index);
    for (let bit = 0; bit < LOW_BITS; bit++) {
      const plane = bitPlaneImage(work, ch.index, bit);
      const explained = explainedShare(work, ch.index, bit, prediction);
      scored.push({ id: `plane-${ch.id}${bit}`, score: planeScore(plane, explained) });
    }
  }
  return scored;
}

export function buildVisuals(work: RgbaImage): Visuals {
  const mid = fitPixels(work, MID_PIXELS);
  const small = fitPixels(work, SMALL_PIXELS);
  const alpha = hasAlpha(work);
  const channels = CHANNELS.filter((c) => c.id !== 'a' || alpha);

  // ---- triage: score the lowest planes of the full working picture
  const scored = scoreLowPlanes(work, channels);
  const names = new Map<string, string>(
    channels.flatMap((ch) =>
      Array.from(
        { length: LOW_BITS },
        (_, bit) => [`plane-${ch.id}${bit}`, planeName(ch.name(), bit)] as const,
      ),
    ),
  );
  const planeSuspects = pickSuspects(scored);
  const near = findNearColours(work);
  const nearIds = near ? ['remap-all', 'remap-step32', 'remap-step85', 'equalize', 'stretch'] : [];

  const reason = new Map<string, string>();
  for (const s of planeSuspects) {
    reason.set(
      s.id,
      T('reason.plane', { plane: names.get(s.id) ?? s.id, score: Math.round(s.score * 100) }),
    );
  }
  if (near) {
    const text = T('reason.remap', {
      a: hex(near.base),
      b: hex(near.near),
      gap: near.gap,
      share: (near.share * 100).toFixed(1),
    });
    for (const id of nearIds) reason.set(id, text);
  }
  const lookFirst = [...planeSuspects.map((s) => s.id), ...nearIds].slice(0, 8);
  const flagged = new Set(lookFirst);

  // ---- pictures
  const make = (
    id: string,
    label: string,
    tier: 'mid' | 'small',
    note: string,
    build: (src: RgbaImage) => RgbaImage,
  ): GalleryItem => {
    const suspect = flagged.has(id);
    const src = suspect ? work : tier === 'mid' ? mid : small;
    return {
      id,
      label,
      image: build(src),
      note: reason.get(id) ?? note,
      ...(suspect ? { suspect: true } : {}),
    };
  };

  const decomposition: GalleryItem[] = [];
  for (const ch of channels) {
    for (let bit = 0; bit < 8; bit++) {
      decomposition.push(
        make(
          `plane-${ch.id}${bit}`,
          `${ch.letter}${bit} · ${planeName(ch.name().toLowerCase(), bit)}`,
          bit < LOW_BITS ? 'mid' : 'small',
          T('note.plane'),
          (src) => bitPlaneImage(src, ch.index, bit),
        ),
      );
    }
  }

  const superimposed: GalleryItem[] = [];
  for (const mode of MODES) {
    for (let bit = 0; bit < 8; bit++) {
      superimposed.push(
        make(
          `mix-${mode}${bit}`,
          T('label.mix', { bit, op: mode.toUpperCase() }),
          bit < LOW_BITS ? 'mid' : 'small',
          T('note.mix'),
          (src) => superimposePlane(src, bit, mode),
        ),
      );
    }
  }

  const remaps: GalleryItem[] = [];
  if (colourCount(work, REMAP_MAX_COLOURS) <= REMAP_MAX_COLOURS) {
    remaps.push(
      make('remap-all', TB('label.colormap'), 'mid', T('note.remap'), (s) => randomColormap(s, -1)),
    );
  }
  for (const ch of CHANNELS.slice(0, 3)) {
    remaps.push(
      make(
        `remap-${ch.id}`,
        TB('label.colormapChannel', { channel: ch.name() }),
        'mid',
        T('note.remap'),
        (s) => randomColormap(s, ch.index),
      ),
    );
  }
  for (const k of [32, 85]) {
    remaps.push(
      make(`remap-step${k}`, T('label.step', { k }), 'mid', T('note.step'), (s) =>
        mapRgb(s, (r, g, b) => [(r * k) & 255, (g * k) & 255, (b * k) & 255]),
      ),
    );
  }

  const note = T('note.filter');
  const transforms: GalleryItem[] = [
    make('invert', TB('label.inverted'), 'small', note, (s) =>
      mapRgb(s, (r, g, b) => [255 - r, 255 - g, 255 - b]),
    ),
    make('equalize', TB('label.equalized'), 'mid', note, equalize),
    make('stretch', T('label.stretch'), 'mid', note, stretchImage),
    make('gamma-lift', T('label.gamma', { g: 2.2 }), 'small', note, (s) => gammaImage(s, 2.2)),
    make('gamma-drop', T('label.gamma', { g: 0.45 }), 'small', note, (s) => gammaImage(s, 0.45)),
    make('grayscale', TB('label.grayscale'), 'small', note, (s) =>
      mapRgb(s, (r, g, b) => {
        const y = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
        return [y, y, y];
      }),
    ),
  ];
  for (const ch of channels) {
    transforms.push(
      make(
        `channel-${ch.id}`,
        TB('label.channelAlone', { channel: ch.name() }),
        'small',
        note,
        (s) => channelImage(s, ch.index),
      ),
    );
  }
  for (const [a, b] of [
    [0, 1],
    [1, 2],
  ] as const) {
    transforms.push(
      make(
        `diff-${a}${b}`,
        T('label.diffSub', { a: CHANNELS[a]!.letter, b: CHANNELS[b]!.letter }),
        'small',
        note,
        (s) => channelDiff(s, a, b, 'sub'),
      ),
    );
  }
  transforms.push(
    make('diff-xor', T('label.diffXor', { a: 'R', b: 'G' }), 'small', note, (s) =>
      channelDiff(s, 0, 1, 'xor'),
    ),
    make('sobel', T('label.sobel'), 'small', note, sobel),
  );
  for (const mode of ['min', 'max', 'median'] as const) {
    transforms.push(
      make(`reduce-${mode}`, T('label.reduce', { mode }), 'small', note, (s) => rgbReduce(s, mode)),
    );
  }

  const groups = [
    { title: T('group.decomposition'), items: decomposition },
    { title: T('group.superimposed'), items: superimposed },
    { title: T('group.remap'), items: remaps },
    { title: T('group.transforms'), items: transforms },
  ];
  const labels = new Map(groups.flatMap((g) => g.items).map((i) => [i.id, i.label]));
  const present = lookFirst.filter((id) => labels.has(id));
  // The colour-remap reason is one sentence for five pictures: say it once.
  const reasons: [string, string][] = [];
  for (const id of present) {
    const text = reason.get(id)!;
    if (!reasons.some(([, r]) => r === text)) reasons.push([labels.get(id)!, text]);
  }
  return { groups, lookFirst: present, reasons, near, scored: scored.length };
}
