/**
 * The SSTV modes the `sstv` tool decodes, with the timings of the published specifications
 * (J. L. Barber, "Proposed new slow-scan modes" / the Robot, Martin, Scottie and PD documents).
 * All times are in milliseconds, measured from the start of one sync "sequence": one line for
 * Robot and Martin and Scottie, a pair of lines for PD (one sync pulse for two picture rows).
 *
 * Tone plan shared by every mode: 1200 Hz sync pulse, 1500 Hz = black, 2300 Hz = white.
 */

export const FREQ_SYNC = 1200;
export const FREQ_BLACK = 1500;
export const FREQ_WHITE = 2300;

/** What a scan carries: R, G, B directly, or Y (luma), Cr = R-Y, Cb = B-Y; Y2 is PD's second row. */
export type Plane = 'R' | 'G' | 'B' | 'Y' | 'Cr' | 'Cb' | 'Y2';

export interface Scan {
  plane: Plane;
  /** Start of the scan, ms after the start of the sequence. */
  start: number;
  /** Length of the scan in ms. */
  length: number;
  /** Samples the transmitter sends across the scan (chroma is half width in Robot modes). */
  pixels: number;
}

export interface SstvMode {
  id: string;
  name: string;
  /** 7-bit VIS code. */
  vis: number;
  width: number;
  height: number;
  /** Picture rows carried by one sequence (2 for PD). */
  rowsPerSequence: 1 | 2;
  /** Time between two sync pulses, ms. */
  period: number;
  /** Sync pulse length, ms, and its start inside the sequence (Scottie: between B and R). */
  syncMs: number;
  syncAt: number;
  /** 'ycc' = luma and two colour differences (Robot, PD); 'rgb' = one scan per colour. */
  colour: 'rgb' | 'ycc';
  /** The scans of a sequence. Robot 36 alternates two layouts (R-Y on even lines, B-Y on odd). */
  scans: Scan[][];
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

function martin(id: string, name: string, vis: number, scanMs: number): SstvMode {
  const sync = 4.862;
  const gap = 0.572;
  const g = sync + gap;
  const b = g + scanMs + gap;
  const r = b + scanMs + gap;
  return {
    id,
    name,
    vis,
    width: 320,
    height: 256,
    rowsPerSequence: 1,
    period: round3(r + scanMs + gap),
    syncMs: sync,
    syncAt: 0,
    colour: 'rgb',
    scans: [
      [
        { plane: 'G', start: round3(g), length: scanMs, pixels: 320 },
        { plane: 'B', start: round3(b), length: scanMs, pixels: 320 },
        { plane: 'R', start: round3(r), length: scanMs, pixels: 320 },
      ],
    ],
  };
}

/** Scottie: [1.5] G [1.5] B [sync 9] [1.5] R; the sync pulse sits between B and R. */
function scottie(id: string, name: string, vis: number, scanMs: number): SstvMode {
  const sep = 1.5;
  const b = sep + scanMs + sep;
  const sync = b + scanMs;
  const r = sync + 9 + sep;
  return {
    id,
    name,
    vis,
    width: 320,
    height: 256,
    rowsPerSequence: 1,
    period: round3(r + scanMs),
    syncMs: 9,
    syncAt: round3(sync),
    colour: 'rgb',
    scans: [
      [
        { plane: 'G', start: sep, length: scanMs, pixels: 320 },
        { plane: 'B', start: round3(b), length: scanMs, pixels: 320 },
        { plane: 'R', start: round3(r), length: scanMs, pixels: 320 },
      ],
    ],
  };
}

/** Robot 36 / 72: 9 ms sync, 3 ms porch, Y, then the chroma scans after short separators. */
function robot36(): SstvMode {
  const y = { plane: 'Y', start: 12, length: 88, pixels: 320 } as const;
  return {
    id: 'robot36',
    name: 'Robot 36',
    vis: 8,
    width: 320,
    height: 240,
    rowsPerSequence: 1,
    period: 150,
    syncMs: 9,
    syncAt: 0,
    colour: 'ycc',
    scans: [
      [y, { plane: 'Cr', start: 106, length: 44, pixels: 160 }],
      [y, { plane: 'Cb', start: 106, length: 44, pixels: 160 }],
    ],
  };
}

function robot72(): SstvMode {
  return {
    id: 'robot72',
    name: 'Robot 72',
    vis: 12,
    width: 320,
    height: 240,
    rowsPerSequence: 1,
    period: 300,
    syncMs: 9,
    syncAt: 0,
    colour: 'ycc',
    scans: [
      [
        { plane: 'Y', start: 12, length: 138, pixels: 320 },
        { plane: 'Cr', start: 156, length: 69, pixels: 160 },
        { plane: 'Cb', start: 231, length: 69, pixels: 160 },
      ],
    ],
  };
}

/** PD: 20 ms sync, 2.08 ms porch, then Y of row 2n, R-Y, B-Y and Y of row 2n+1. */
function pd(id: string, name: string, vis: number, width: number, height: number, pixelMs: number) {
  const scan = round3(width * pixelMs);
  const first = 22.08;
  return {
    id,
    name,
    vis,
    width,
    height,
    rowsPerSequence: 2,
    period: round3(first + 4 * scan),
    syncMs: 20,
    syncAt: 0,
    colour: 'ycc',
    scans: [
      [
        { plane: 'Y', start: first, length: scan, pixels: width },
        { plane: 'Cr', start: round3(first + scan), length: scan, pixels: width },
        { plane: 'Cb', start: round3(first + 2 * scan), length: scan, pixels: width },
        { plane: 'Y2', start: round3(first + 3 * scan), length: scan, pixels: width },
      ],
    ],
  } satisfies SstvMode;
}

export const MODES: readonly SstvMode[] = [
  robot36(),
  robot72(),
  martin('martin-m1', 'Martin M1', 44, 146.432),
  martin('martin-m2', 'Martin M2', 40, 73.216),
  scottie('scottie-s1', 'Scottie S1', 60, 138.24),
  scottie('scottie-s2', 'Scottie S2', 56, 88.064),
  scottie('scottie-dx', 'Scottie DX', 76, 345.6),
  pd('pd50', 'PD 50', 93, 320, 256, 0.286),
  pd('pd90', 'PD 90', 99, 320, 256, 0.532),
  pd('pd120', 'PD 120', 95, 640, 496, 0.19),
  pd('pd160', 'PD 160', 98, 512, 400, 0.382),
  pd('pd180', 'PD 180', 96, 640, 496, 0.286),
  pd('pd240', 'PD 240', 97, 640, 496, 0.382),
  pd('pd290', 'PD 290', 94, 800, 616, 0.286),
];

export const modeById = (id: string): SstvMode | undefined => MODES.find((m) => m.id === id);
export const modeByVis = (code: number): SstvMode | undefined => MODES.find((m) => m.vis === code);

/** Time from the start of the first sequence to its sync pulse's middle, ms. */
export const syncCentre = (m: SstvMode): number => m.syncAt + m.syncMs / 2;

/** The scans of sequence number `index` (Robot 36 alternates). */
export const scansOf = (m: SstvMode, index: number): Scan[] => m.scans[index % m.scans.length]!;

/** Number of sync sequences in a whole picture. */
export const sequencesOf = (m: SstvMode): number => Math.ceil(m.height / m.rowsPerSequence);
