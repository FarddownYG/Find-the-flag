import { bool, defineTool, number, select } from '../../core/define';
import type { Output, RgbaImage } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import {
  CHANNEL_INFO,
  DEFAULT_REVEAL,
  buildLut,
  channelInfo,
  channelName,
  normalizeCrop,
  type Rect,
} from './_channel';
import {
  COLS,
  DEFAULT_MAPPING,
  ROWS,
  SEPARATOR_COLUMN,
  columnValue,
  decodeDocuColor,
  mappedColumns,
  matrixToText,
  orient,
  orientationKey,
  orientationText,
  singleDotFix,
  type Decoded,
  type Mapping,
} from './_docucolor';
import {
  columnTable,
  dateText,
  makerNote,
  mappingNote,
  mappingOptions,
  orientationChoices,
  parityCell,
  parityOption,
  parityText,
  printed,
  readMapping,
  serialText,
  shortOrientation,
} from './_docucolor-ui';
import { detectCached, type DotDetection, type Signal } from './_printer-dots-detect';
import {
  cellCenter,
  countCopies,
  estimateBasis,
  fitLattice,
  latticeFrom,
  latticeParams,
  sampleGrid,
  searchWindows,
  shapesFor,
  windowCells,
  type CellGrid,
  type Lattice,
  type OrientedShape,
  type WindowHit,
} from './_printer-dots-grid';
import {
  OVERLAY_MAX_SIDE,
  autoZoom,
  poolLevel,
  renderOverlay,
  type Display,
  type OverlayLabel,
  type OverlayWindow,
} from './_printer-dots-overlay';

// Tile layout, bit weights, column mapping, parity and century: EFF "DocuColor Tracking Dot
// Decoding Guide" (https://w2.eff.org/Privacy/printers/docucolor/) and DEDA by dfd-tud
// (https://github.com/dfd-tud/deda, libdeda/pattern_handler.py, Pattern4: dot pitch 0.04 inch).
// Both are summarised in _docucolor.ts. No code was copied.

const T = toolT('printer-dots');
/** Cells sampled at most (a 2-px pitch over a 12-megapixel scan would be 3 million). */
const MAX_CELLS = 2_000_000;
const MAX_ROTATION = 45;
/** A reading seen in fewer than 1/VOTE as many windows as the most frequent one is outvoted. */
const VOTE = 10;

const f1 = (n: number) => n.toFixed(1);
const f2 = (n: number) => n.toFixed(2);
const adv = (v: Record<string, unknown>) => v.advanced === true;

/**
 * The last fit and window search, reused while only picture or decoding options change (the
 * detection is cached the same way, see detectCached). Keyed by the detection object itself.
 */
const memo: {
  det: DotDetection | null;
  fitKey: string;
  fit: { lattice: Lattice; inliers: number; rms: number } | null;
  searchKey: string;
  search: ReturnType<typeof searchWindows> | null;
  grid: CellGrid | null;
} = { det: null, fitKey: '', fit: null, searchKey: '', search: null, grid: null };

/** One reading: the windows that give the same date and serial (or the same bits). */
interface Candidate {
  hit: WindowHit;
  shape: OrientedShape;
  /** Window cells as seen in the image, and the tile once oriented. */
  window: boolean[][];
  tile: boolean[][];
  count: number;
  decoded: Decoded | null;
  plausible: boolean;
  separatorFull: boolean;
  /** Parity fails but flipping one dot fixes it and gives plausible values. */
  oneDotAway: boolean;
}

/** How sure the reading is. */
type Status = 'sure' | 'ambiguous' | 'implausible' | 'failed';

export default defineTool({
  id: 'printer-dots',
  name: 'Printer tracking dots (yellow dots / MIC)',
  category: 'stego',
  description:
    'Find the Xerox DocuColor yellow-dot grid in a scan, fit it (rotation, pitch, origin, orientation) and decode the print date, time and printer serial, with parity check.',
  tags: [
    'yellow dots',
    'tracking dots',
    'machine identification code',
    'MIC',
    'docucolor',
    'printer steganography',
    'printer forensics',
    'Xerox',
    'EFF',
    'DEDA',
    'blue channel',
    'scan',
    'points jaunes',
    'imprimante',
  ],
  input: 'image',
  placeholder:
    'Drop a scan or photo of a printed page (PNG keeps every pixel exact). Nothing leaves your browser.',
  live: true,
  options: {
    // ---- detection ----
    channel: select(
      'Channel',
      CHANNEL_INFO.map((c) => ({ value: c.id, label: `${c.name} (${c.formula})` })),
      DEFAULT_REVEAL.channel,
      { hint: 'Yellow dots only show in the blue channel (or its complement, Yellow).' },
    ),
    inkOnly: bool('Colour ink only', true, {
      hint: 'Measure the channel against the two others (yellow = min(R, G) − B), so black text, grey shading and the paper tone disappear and only coloured ink is left. R/G/B/C/M/Y only.',
    }),
    threshold: number('Dot threshold (0 = auto)', 0, {
      min: 0,
      max: 255,
      hint: 'Minimum dot contrast, in levels above the local paper (3 × 3 average). Auto: 4 noise sigmas, raised to 40 % of the typical dot.',
    }),
    cropX: number('Region X (px)', 0, {
      min: 0,
      hint: 'Left edge of the analysed region. A region around the dots is faster and leaves out logos and colour figures.',
    }),
    cropY: number('Region Y (px)', 0, { min: 0, hint: 'Top edge of the analysed region.' }),
    cropW: number('Region width (0 = to the edge)', 0, {
      min: 0,
      hint: 'With every region field at 0 the whole image is analysed.',
    }),
    cropH: number('Region height (0 = to the edge)', 0, { min: 0 }),
    // ---- pictures only ----
    stretch: select(
      'Picture',
      [
        { value: 'dots', label: 'Dots (paper removed)' },
        { value: 'auto', label: 'Channel, auto stretch' },
        { value: 'full', label: 'Channel, full range' },
        { value: 'equalize', label: 'Channel, equalized' },
        { value: 'none', label: 'Channel, no stretch' },
      ],
      'dots',
      {
        hint: 'Changes the pictures only, never the decoding. Dots = the dot contrast above the local paper level, as the detector sees it.',
      },
    ),
    invert: bool('Invert', DEFAULT_REVEAL.invert, {
      hint: 'Pictures only. Dots view: white dots on black (on) or black on white (off). Channel views: 255 − value, so ink turns bright.',
    }),
    gain: number('Gain', DEFAULT_REVEAL.gain, {
      min: 0,
      max: 255,
      step: 0.5,
      hint: 'Pictures only: multiplier after the stretch.',
    }),
    gamma: number('Gamma', DEFAULT_REVEAL.gamma, {
      min: 0.1,
      max: 10,
      step: 0.1,
      hint: 'Pictures only: above 1 brightens the mid-tones.',
    }),
    zoom: number('Zoom (0 = auto)', 0, {
      min: 0,
      max: 16,
      hint: 'Zoom of the fit picture; auto aims at about 24 screen pixels per cell.',
    }),
    // ---- manual grid and decoding ----
    advanced: bool('Manual grid and column mapping', false, {
      hint: 'Tile size, pitch, rotation, origin, orientation, column mapping, century and parity. Off = everything automatic with the EFF mapping.',
    }),
    cols: number('Tile columns', COLS, {
      min: 2,
      max: 32,
      showIf: adv,
      hint: 'DocuColor: 15 × 8. A sideways tile is handled by Orientation, not by swapping these. Other sizes show the bits without decoding.',
    }),
    rows: number('Tile rows', ROWS, { min: 2, max: 32, showIf: adv }),
    pitchX: number('Pitch X (px, 0 = auto)', 0, {
      min: 0,
      step: 0.1,
      showIf: adv,
      hint: 'Distance between neighbouring dot centres along the grid rows. DocuColor: 0.04 inch, i.e. 12 px at 300 dpi.',
    }),
    pitchY: number('Pitch Y (px, 0 = same as X)', 0, {
      min: 0,
      step: 0.1,
      showIf: adv,
      hint: '0 = same as Pitch X when that is set, else automatic.',
    }),
    autoRotation: bool('Auto rotation', true, { showIf: adv }),
    rotation: number('Rotation (°, clockwise)', 0, {
      min: -MAX_ROTATION,
      max: MAX_ROTATION,
      step: 0.1,
      showIf: (v) => adv(v) && v.autoRotation === false,
      hint: 'Within ±45°; quarter and half turns are Orientation.',
    }),
    autoOrigin: bool('Auto origin (search the whole region)', true, { showIf: adv }),
    originX: number('Origin X (px)', 0, {
      step: 0.1,
      showIf: (v) => adv(v) && v.autoOrigin === false,
      hint: 'Centre of the tile’s top-left cell as seen in the image (the fit reports it as Origin).',
    }),
    originY: number('Origin Y (px)', 0, {
      step: 0.1,
      showIf: (v) => adv(v) && v.autoOrigin === false,
    }),
    orientation: select('Orientation', orientationChoices('Auto (try all 8)'), 'auto', {
      showIf: adv,
      hint: 'How the grid must be turned to read the tile with its parity row on top and parity column on the left. Auto tries all 8 and keeps what passes parity.',
    }),
    ...mappingOptions((v) => adv(v) && v.cols === COLS && v.rows === ROWS),
    parity: parityOption(adv),
  },
  examples: [
    {
      label: 'Scanned page (synthetic, tilted 2°, upside down)',
      input: { sample: 'printer-dots-synthetic.png' },
      expect: 'Printed: 2024-11-05 14:37',
    },
    {
      label: 'One faint tile in the corner of a page',
      input: { sample: 'printer-dots-corner.png' },
      expect: 'Printed: 1998-03-17 09:26',
    },
    {
      label: 'Tight crop of one tile',
      input: { sample: 'printer-dots-crop.png' },
      expect: 'Printed: 2019-02-28 07:05',
    },
    {
      label: 'Manual grid: pitch, rotation, origin, orientation',
      input: { sample: 'printer-dots-crop.png' },
      options: {
        advanced: true,
        pitchX: 16,
        autoRotation: false,
        rotation: 0,
        autoOrigin: false,
        originX: 40,
        originY: 40,
        orientation: 'r0',
      },
      expect: 'Serial: 24681357',
    },
    {
      label: 'One region of the page',
      input: { sample: 'printer-dots-synthetic.png' },
      options: { cropX: 110, cropY: 40, cropW: 240, cropH: 150 },
      expect: 'Serial: 13572468',
    },
  ],
  run({ image }, o) {
    const head: Output[] = [];
    const notes: Output[] = [];
    const warn = (text: string) => notes.push({ type: 'note', level: 'warn', text });

    // ---------- options (the advanced ones only count when shown) ----------
    let tileRows = ROWS;
    let tileCols = COLS;
    if (o.advanced) {
      const ok = (n: number) => Number.isInteger(n) && n >= 2 && n <= 32;
      if (ok(o.rows) && ok(o.cols)) {
        tileRows = o.rows;
        tileCols = o.cols;
      } else warn(T('warn.tile-size', { cols: o.cols, rows: o.rows }));
    }
    const docu = tileRows === ROWS && tileCols === COLS;
    const odd = !o.advanced || o.parity === 'odd';
    let mapping: Mapping = DEFAULT_MAPPING;
    if (o.advanced && docu) {
      const r = readMapping(o);
      if ('problem' in r) warn(T('warn.mapping-ignored', { problem: r.problem }));
      else mapping = r.mapping;
    }
    const mapped = docu ? mappedColumns(mapping) : new Map<number, string>();

    let manualPitchX: number | null = o.advanced && o.pitchX > 0 ? o.pitchX : null;
    let manualPitchY: number | null = o.advanced && o.pitchY > 0 ? o.pitchY : manualPitchX;
    if ((manualPitchX ?? 2) < 2 || (manualPitchY ?? 2) < 2) {
      warn(T('warn.pitch'));
      manualPitchX = null;
      manualPitchY = null;
    }
    let rotation: number | null = null;
    if (o.advanced && !o.autoRotation) {
      rotation = Number.isFinite(o.rotation) ? o.rotation : 0;
      if (Math.abs(rotation) > MAX_ROTATION) {
        warn(T('warn.rotation', { rotation, max: MAX_ROTATION }));
        rotation = Math.sign(rotation) * MAX_ROTATION;
      }
    }
    const manualOrigin = o.advanced && !o.autoOrigin ? { x: o.originX, y: o.originY } : null;
    const allManual = manualPitchX !== null && manualPitchY !== null && rotation !== null;

    // ---------- 1. region, detection, pictures ----------
    const crop = normalizeCrop(image, { x: o.cropX, y: o.cropY, w: o.cropW, h: o.cropH });
    const rect = crop.rect;
    if (crop.adjusted)
      warn(
        T('warn.region-adjusted', {
          iw: image.width,
          ih: image.height,
          w: rect.w,
          h: rect.h,
          x: rect.x,
          y: rect.y,
        }),
      );
    if (rect.w * rect.h > 4_000_000)
      notes.push({
        type: 'note',
        level: 'info',
        text: T('note.large-region', { mp: f1((rect.w * rect.h) / 1e6) }),
      });
    const { sig, det } = detectCached(image, rect, o.channel, o.inkOnly, o.threshold);
    const info = channelInfo(o.channel);
    const display = makeDisplay(sig, det, o);
    const statsBlock = (): Output => ({
      type: 'kv',
      label: T('label.stats'),
      entries: [
        [
          T('kv.channel'),
          `${channelName(o.channel)} (${info.formula})${
            sig.inkOnly ? T('value.ink-only') : o.inkOnly ? T('value.ink-only-na') : ''
          }`,
        ],
        [
          T('kv.region'),
          crop.whole
            ? T('value.region-whole', { w: rect.w, h: rect.h })
            : T('value.region-part', {
                w: rect.w,
                h: rect.h,
                x: rect.x,
                y: rect.y,
                iw: image.width,
                ih: image.height,
              }),
        ],
        [T('kv.range'), `${sig.stats.min}–${sig.stats.max}`],
        [T('kv.mean'), f2(sig.stats.mean)],
        ['p1', String(sig.stats.p1)],
        ['p99', String(sig.stats.p99)],
        [
          T('kv.dot-threshold'),
          det.auto
            ? T('value.threshold-auto', { t: det.threshold, noise: f1(det.noise) })
            : T('value.threshold-manual', { t: det.threshold }),
        ],
        [
          T('kv.blobs'),
          `${T('value.blobs', {
            blobs: det.blobs,
            dots: det.dots.length,
            area: det.typicalArea,
            peak: f1(det.peak),
            faint: det.rejectedFaint,
            small: det.rejectedSmall,
            large: det.rejectedLarge,
          })}${det.truncated ? T('value.blobs-stopped') : ''}`,
        ],
      ],
    });
    const localNote: Output = { type: 'note', level: 'info', text: T('note.local') };
    const plainPicture = (): Output => ({
      type: 'image',
      label: T('label.revealed', { view: display.name }),
      image: poolLevel(display, rect, OVERLAY_MAX_SIDE),
      filename: 'printer-dots-reveal.png',
    });
    const giveUp = (why: string): Output[] => [
      { type: 'note', level: 'error', text: why },
      ...notes,
      localNote,
      plainPicture(),
      statsBlock(),
    ];

    // ---------- 2. grid ----------
    const points = det.dots;
    if (det.truncated) return giveUp(T('error.too-many', { blobs: det.blobs }));
    if (points.length < 4 && !(allManual && manualOrigin))
      return giveUp(noDotsAdvice(o, sig, det, crop.whole));

    // Anything memoized for another detection (another picture, region or threshold) is stale.
    if (memo.det !== det)
      Object.assign(memo, { det, fitKey: '', fit: null, searchKey: '', search: null, grid: null });
    let lattice: Lattice;
    let inliers = 0;
    let rms = 0;
    if (allManual && manualOrigin) {
      lattice = latticeFrom(
        { pitchX: manualPitchX ?? 0, pitchY: manualPitchY ?? 0, rotation: rotation ?? 0 },
        manualOrigin.x,
        manualOrigin.y,
      );
    } else {
      const fitKey = `${manualPitchX}|${manualPitchY}|${rotation}`;
      let fit = memo.fitKey === fitKey ? memo.fit : null;
      if (!fit) {
        const est = allManual ? null : estimateBasis(points);
        if (!allManual && !est)
          return giveUp(
            T(crop.whole ? 'error.no-spacing-whole' : 'error.no-spacing-region', {
              count: points.length,
            }),
          );
        const params = {
          pitchX: manualPitchX ?? est?.pitchX ?? 0,
          pitchY: manualPitchY ?? est?.pitchY ?? 0,
          rotation: rotation ?? est?.rotation ?? 0,
        };
        // Any value given by hand stays as given: then only the phase (origin) is fitted.
        fit = fitLattice(
          points,
          latticeFrom(params, 0, 0),
          manualPitchX === null && manualPitchY === null && rotation === null,
        );
        Object.assign(memo, { fitKey, fit, searchKey: '' });
      }
      lattice = manualOrigin
        ? { ...fit.lattice, ox: manualOrigin.x, oy: manualOrigin.y }
        : fit.lattice;
      inliers = fit.inliers;
      rms = fit.rms;
      if (points.length >= 10 && inliers < 0.6 * points.length)
        warn(T('warn.inliers', { inliers, n: points.length }));
    }
    const lp = latticeParams(lattice);
    const pitchMin = Math.min(lp.pitchX, lp.pitchY);
    const rad = Math.max(1, Math.round(0.22 * pitchMin));
    const isDot = (x: number, y: number) => {
      const cx = Math.floor(x) - rect.x;
      const cy = Math.floor(y) - rect.y;
      for (let yy = Math.max(0, cy - rad); yy <= Math.min(rect.h - 1, cy + rad); yy++)
        for (let xx = Math.max(0, cx - rad); xx <= Math.min(rect.w - 1, cx + rad); xx++)
          if (det.accept[yy * rect.w + xx]) return true;
      return false;
    };
    const gridKey = `${det.threshold}|${lattice.ox},${lattice.oy},${lattice.ax},${lattice.ay},${lattice.bx},${lattice.by}`;
    const sameGrid =
      memo.det === det && memo.grid !== null && memo.searchKey.startsWith(`${gridKey}#`);
    const grid = sameGrid ? memo.grid : sampleGrid(lattice, rect, isDot, MAX_CELLS);
    if (!grid)
      return giveUp(
        T('error.too-many-cells', { pitch: f2(lp.pitchX), max: MAX_CELLS.toLocaleString('en') }),
      );
    const fitEntries = (): [string, string][] => {
      const manual = (m: boolean) => (m ? T('value.manual') : '');
      return [
        [
          T('kv.pitch'),
          `${f2(lp.pitchX)} × ${f2(lp.pitchY)} px${manual(manualPitchX !== null || manualPitchY !== null)}`,
        ],
        [T('kv.rotation'), `${f2(lp.rotation)}°${manual(rotation !== null)}`],
        [
          T('kv.dots'),
          `${T('value.dots-detected', { n: points.length })}${allManual && manualOrigin ? '' : T('value.dots-on-grid', { inliers, rms: f2(rms) })}`,
        ],
      ];
    };

    // ---------- tile search ----------
    const shapes = shapesFor(tileRows, tileCols);
    const allowed = shapes.map(
      (s) =>
        !o.advanced || o.orientation === 'auto' || orientationKey(s.orientation) === o.orientation,
    );
    const autoOrientation = allowed.every(Boolean);
    const at = manualOrigin ? { x: -grid.i0, y: -grid.j0 } : undefined;
    const searchKey = `${gridKey}#${tileRows}x${tileCols}|${allowed.join()}|${odd}|${at ? `${at.x},${at.y}` : ''}`;
    const res =
      memo.det === det && memo.searchKey === searchKey && memo.search
        ? memo.search
        : searchWindows(grid, shapes, allowed, odd, at);
    Object.assign(memo, { det, searchKey, search: res, grid });
    const emptyOverlay = () =>
      overlayBlock(display, rect, lattice, grid, null, o.zoom, pitchMin, []).blocks;
    if (!res.examined)
      return [
        {
          type: 'note',
          level: 'error',
          text: manualOrigin
            ? T('error.no-window-origin', {
                cols: tileCols,
                rows: tileRows,
                x: f1(manualOrigin.x),
                y: f1(manualOrigin.y),
              })
            : T('error.no-window', { cols: tileCols, rows: tileRows, gw: grid.w, gh: grid.h }),
        },
        ...notes,
        localNote,
        ...emptyOverlay(),
        { type: 'kv', entries: fitEntries() },
        statsBlock(),
      ];

    // Group windows that give the same reading; rank the readings.
    const groupHits = (hits: WindowHit[], passing: boolean): Candidate[] => {
      const groups = new Map<string, Candidate>();
      for (const hit of hits) {
        const shape = shapes[hit.shape]!;
        const window = windowCells(grid, hit.x, hit.y, shape.h, shape.w);
        const tile = orient(window, shape.orientation);
        const decoded = docu ? decodeDocuColor(tile, mapping, odd) : null;
        const key = decoded
          ? `${printed(decoded.fields)} ${decoded.fields.serial}`
          : `${hit.shape}:${matrixToText(tile)}`;
        const g = groups.get(key);
        if (g) {
          g.count++;
          continue;
        }
        const fix = decoded && !passing ? singleDotFix(tile, odd) : null;
        groups.set(key, {
          hit,
          shape,
          window,
          tile,
          count: 1,
          decoded,
          plausible: decoded ? decoded.plausible : true,
          separatorFull:
            docu && !mapped.has(SEPARATOR_COLUMN) && columnValue(tile, SEPARATOR_COLUMN) === 127,
          oneDotAway: !!fix && decodeDocuColor(fix.matrix, mapping, odd).plausible,
        });
      }
      // Passing readings: plausible first, then the EFF separator, then the most copies.
      // Near misses (a guess at best): one dot from a plausible tile first, then plausible as
      // read, then the fewest parity errors, then the most copies.
      return [...groups.values()].sort(
        (a, b) =>
          Number(b.oneDotAway) - Number(a.oneDotAway) ||
          Number(b.plausible) - Number(a.plausible) ||
          a.hit.errors - b.hit.errors ||
          Number(b.separatorFull) - Number(a.separatorFull) ||
          b.count - a.count ||
          a.hit.shape - b.hit.shape ||
          a.hit.y - b.hit.y ||
          a.hit.x - b.hit.x,
      );
    };
    const passGroups = groupHits(res.passing, true);
    // Near misses are only needed when nothing valid passes (decoding them all costs time).
    let near: Candidate[] | null = null;
    const nearGroups = () => (near ??= groupHits(res.closest, false));
    // Readings that pass parity with valid values, and among them the credible ones: seen in at
    // least a tenth as many windows as the most frequent. A reading outvoted ten to one is a
    // misread copy (dots hidden under text in a pattern that keeps every parity), not a rival.
    const valid = passGroups.filter((g) => g.plausible);
    const most = Math.max(0, ...valid.map((g) => g.count));
    const credible = valid
      .filter((g) => g.count * VOTE >= most)
      .sort(
        (a, b) =>
          Number(b.separatorFull) - Number(a.separatorFull) ||
          b.count - a.count ||
          a.hit.shape - b.hit.shape ||
          a.hit.y - b.hit.y ||
          a.hit.x - b.hit.x,
      );
    const outvoted = valid.filter((g) => g.count * VOTE < most);

    // The confidence ladder. A green verdict needs exactly one credible reading that passes parity
    // with valid values: two or more (tiles printed edge to edge, a mirrored read, two different
    // tiles) can only be told apart by weak hints, so they are reported as ambiguous.
    let chosen: Candidate | undefined;
    let status: Status;
    let rescued = false;
    if (credible.length) {
      chosen = credible[0];
      status = credible.length === 1 ? 'sure' : 'ambiguous';
    } else if (passGroups.length) {
      // Passing with impossible values is grid structure (a shifted or mirrored read), not a
      // tile: a near miss one dot from a valid tile is then the better guess — still a failure.
      const rescue = docu ? nearGroups().find((g) => g.oneDotAway) : undefined;
      chosen = rescue ?? passGroups[0];
      rescued = !!rescue;
      status = rescue ? 'failed' : 'implausible';
    } else {
      chosen = nearGroups()[0];
      status = 'failed';
    }
    if (!chosen)
      return [
        {
          type: 'note',
          level: 'error',
          text: res.sparse
            ? T('error.sparse', {
                cols: tileCols,
                rows: tileRows,
                min: Math.max(tileCols, tileRows) - 1,
              })
            : T('error.empty-windows', { cols: tileCols, rows: tileRows }),
        },
        ...notes,
        localNote,
        ...emptyOverlay(),
        { type: 'kv', entries: fitEntries() },
        statsBlock(),
      ];
    const d = chosen.decoded;
    const copies = manualOrigin ? null : countCopies(grid, chosen.window, 3);
    const triedText = autoOrientation ? T('value.tried-all') : T('value.tried-chosen');
    const where = manualOrigin
      ? T('value.at-origin')
      : T('value.of-positions', { count: res.examined });
    const topLeft = cellCenter(lattice, grid.i0 + chosen.hit.x, grid.j0 + chosen.hit.y);
    const copiesText = copies && copies.exact > 1 ? T('value.copies', { count: copies.exact }) : '';
    const parityOf = T(odd ? 'value.parity-of.odd' : 'value.parity-of.even');

    // ---------- verdict ----------
    if (docu && d) {
      if (status === 'sure') {
        head.push({
          type: 'note',
          level: 'success',
          text: T('note.sure', {
            parity: T(odd ? 'value.dots-count.odd' : 'value.dots-count.even'),
            others: outvoted.length ? T('value.others-outvoted') : T('value.no-other'),
            copies: copiesText,
          }),
        });
      } else if (status === 'ambiguous') {
        const second = credible[1]!;
        const why =
          chosen.separatorFull && !second.separatorFull
            ? T('value.why-separator')
            : chosen.count > second.count
              ? T('value.why-most', { count: chosen.count, other: second.count })
              : T('value.why-first');
        head.push({
          type: 'note',
          level: 'warn',
          text: T('note.ambiguous', { count: credible.length, why }),
        });
      } else if (status === 'implausible') {
        head.push({
          type: 'note',
          level: 'warn',
          text: T('note.implausible', { issues: d.issues.join('; ') }),
        });
      } else {
        head.push({
          type: 'note',
          level: 'error',
          text: T('note.failed', { bad: parityText(d.parity), tried: triedText, where }),
        });
        const guess = singleDotFix(chosen.tile, odd);
        const alt = guess ? decodeDocuColor(guess.matrix, mapping, odd) : null;
        if (guess && alt?.plausible)
          warn(
            T('warn.one-dot', {
              row: guess.row,
              col: guess.col,
              printed: printed(alt.fields),
              serial: alt.fields.serial,
            }),
          );
      }
    } else {
      const passed = chosen.hit.errors === 0;
      head.push({
        type: 'note',
        level: passed ? 'info' : 'error',
        text: passed
          ? T(passGroups.length > 1 ? 'note.structure-many' : 'note.structure-one', {
              count: passGroups.length,
              cols: tileCols,
              rows: tileRows,
              parity: parityOf,
              copies: copiesText,
            })
          : T('note.structure-none', {
              cols: tileCols,
              rows: tileRows,
              parity: parityOf,
              tried: triedText,
              where,
            }),
      });
    }
    if (outvoted.length && (status === 'sure' || status === 'ambiguous')) {
      const o0 = outvoted[0]!;
      notes.push({
        type: 'note',
        level: 'info',
        text: T('note.outvoted', {
          count: outvoted.length,
          printed: printed(o0.decoded!.fields),
          serial: o0.decoded!.fields.serial,
          windows: T('value.windows', { count: o0.count }),
          chosen: chosen.count,
          vote: VOTE,
        }),
      });
    }
    if (rescued)
      warn(
        T('warn.rescued', {
          count: passGroups.length,
          issue: String(passGroups[0]!.decoded!.issues[0]),
        }),
      );
    if (res.truncated) warn(T('warn.too-many-passing', { n: res.passing.length }));
    const maker = d ? makerNote(d) : null;
    if (maker) notes.push(maker);
    const custom = docu ? mappingNote(mapping) : null;
    if (custom) notes.push(custom);

    // ---------- the answer ----------
    if (docu && d) {
      const suffix = {
        sure: '',
        ambiguous: T('value.suffix-ambiguous'),
        implausible: T('value.suffix-implausible'),
        failed: T('value.suffix-guess'),
      }[status];
      head.push({
        type: 'kv',
        entries: [
          [T('kv.printed'), `${dateText(d)}${suffix}`],
          [T('kv.serial'), `${serialText(d)}${suffix}`],
          [
            T('kv.parity'),
            d.parity.ok
              ? T('value.parity-ok')
              : T('value.parity-failed', { bad: parityText(d.parity) }),
          ],
        ],
      });
    }

    // ---------- picture ----------
    const shape = chosen.shape;
    const lines = (want: (r: number, c: number) => boolean) => {
      const rows: number[] = [];
      const cols: number[] = [];
      shape.rowLine.forEach((l, r) => want(r, -1) && (l.col ? cols : rows).push(l.index));
      shape.colLine.forEach((l, c) => want(-1, c) && (l.col ? cols : rows).push(l.index));
      return { rows, cols };
    };
    const badRows = new Set((d?.parity.badRows ?? []).map((r) => r - 1));
    const badCols = new Set((d?.parity.badCols ?? []).map((c) => c - 1));
    const parityLines = lines((r, c) => r === 0 || c === 0);
    const badLines = lines((r, c) => badRows.has(r) || badCols.has(c));
    const win: OverlayWindow = {
      x: chosen.hit.x,
      y: chosen.hit.y,
      w: shape.w,
      h: shape.h,
      parityRows: parityLines.rows,
      parityCols: parityLines.cols,
      badRows: badLines.rows,
      badCols: badLines.cols,
    };
    // Tile row and column numbers, just outside the window, in tile orientation.
    const labels: OverlayLabel[] = [];
    const label = (l: { col: boolean; index: number }, n: number) => {
      const p = l.col
        ? cellCenter(lattice, grid.i0 + win.x + l.index, grid.j0 + win.y - 1)
        : cellCenter(lattice, grid.i0 + win.x - 1, grid.j0 + win.y + l.index);
      labels.push({ x: p.x, y: p.y, text: String(n) });
    };
    shape.colLine.forEach((l, c) => label(l, c + 1));
    shape.rowLine.forEach((l, r) => label(l, r + 1));
    const overlay = overlayBlock(display, rect, lattice, grid, win, o.zoom, pitchMin, labels);

    // ---------- details ----------
    const details: [string, string][] = [
      [
        T('kv.orientation'),
        `${orientationText(shape.orientation)} (${autoOrientation ? T('value.auto') : T('value.forced')})`,
      ],
      ...fitEntries(),
      [
        T('kv.origin'),
        `${T('value.origin', { x: f1(topLeft.x), y: f1(topLeft.y) })}${manualOrigin ? T('value.manual') : ''}`,
      ],
    ];
    if (copies)
      details.push([
        T('kv.copies'),
        `${T('value.identical', { n: copies.exact })}${copies.near ? T('value.near-copies', { n: copies.near }) : ''}`,
      ]);

    const out: Output[] = [...head, ...notes, localNote, ...overlay.blocks];
    out.push({ type: 'kv', label: T('label.grid-fit'), entries: details });

    // ---------- tables ----------
    if (docu && d) out.push(columnTable(d, mapping));
    if (docu && valid.length > 1)
      out.push({
        type: 'table',
        label: T('label.readings', { n: valid.length }),
        columns: [
          T('col.printed'),
          T('col.serial'),
          T('col.windows'),
          T('col.col10'),
          T('col.orientation'),
        ],
        rows: [...credible, ...outvoted]
          .slice(0, 12)
          .map((g) => [
            printed(g.decoded!.fields),
            g.decoded!.fields.serial,
            g.count,
            g.separatorFull ? T('value.yes') : T('value.no'),
            shortOrientation(g.shape.orientation),
          ]),
        highlight: [0],
      });
    const perOrientation = shapes.map((s, k) => {
      const name = shortOrientation(s.orientation);
      if (!allowed[k]) return [name, T('value.not-tried'), '', '', '', ''];
      const own =
        passGroups.find((g) => g.hit.shape === k) ??
        (valid.length ? undefined : nearGroups().find((g) => g.hit.shape === k));
      const hit = (chosen.hit.shape === k ? chosen : own)?.hit ?? res.perShape[k];
      if (!hit) return [name, T('value.no-window'), '', '', '', ''];
      const tile = orient(windowCells(grid, hit.x, hit.y, s.h, s.w), s.orientation);
      const p = cellCenter(lattice, grid.i0 + hit.x, grid.j0 + hit.y);
      const pos = `${Math.round(p.x)},${Math.round(p.y)}`;
      if (!docu)
        return [
          name,
          hit.errors ? T('value.fail-times', { n: hit.errors }) : T('value.cell-ok'),
          '',
          '',
          '',
          pos,
        ];
      const td = decodeDocuColor(tile, mapping, odd);
      return [
        name,
        parityCell(td.parity),
        td.plausible ? T('value.yes') : T('value.no'),
        dateText(td),
        serialText(td),
        pos,
      ];
    });
    out.push({
      type: 'table',
      label: T('label.orientations', { count: res.examined }),
      columns: [
        T('col.orientation'),
        T('col.parity'),
        T('col.valid'),
        T('col.printed'),
        T('col.serial'),
        T('col.at'),
      ],
      rows: perOrientation,
      highlight: [chosen.hit.shape],
    });
    out.push({
      type: 'text',
      label: `${T('label.tile')}${docu ? T('label.tile-pipe') : ''}`,
      value: matrixToText(chosen.tile),
    });
    out.push(statsBlock());
    return out;
  },
});

interface PictureOptions {
  stretch: 'dots' | 'auto' | 'full' | 'equalize' | 'none';
  invert: boolean;
  gain: number;
  gamma: number;
}

/** What the pictures show. Display options never reach the detection. */
function makeDisplay(
  sig: Signal,
  det: DotDetection,
  o: PictureOptions,
): Display & { name: string } {
  const gain = Number.isFinite(o.gain) ? Math.max(0, o.gain) : 1;
  const gamma = Number.isFinite(o.gamma) ? Math.max(0.01, o.gamma) : 1;
  if (o.stretch === 'dots' && det.peak > 0) {
    // Dot contrast (× 9): twice the noise and below is black, the typical dot is white.
    const lo = 9 * Math.max(1, 2 * det.noise);
    const hi = Math.max(lo + 9, 9 * det.peak);
    const lut = new Uint8Array(9 * 255 + 1);
    for (let c = 0; c < lut.length; c++) {
      let t = Math.min(1, Math.max(0, (c - lo) / (hi - lo)));
      t = Math.min(1, t * gain);
      if (gamma !== 1) t = t ** (1 / gamma);
      const level = Math.round(255 * t);
      lut[c] = o.invert ? level : 255 - level;
    }
    return { source: det.contrast, lut, dotsBright: o.invert, name: T('value.view-dots') };
  }
  const stretch = o.stretch === 'dots' ? 'auto' : o.stretch;
  const lut = buildLut(sig.hist, { invert: o.invert, stretch, gain, gamma, threshold: 0 });
  const name = `${sig.inkOnly ? T('value.view-ink') : T('value.view-channel')}, ${T(`value.view-stretch.${stretch}`)}${
    o.stretch === 'dots' ? T('value.view-no-dots') : ''
  }`;
  return { source: sig.raw, lut, dotsBright: sig.darkDots === o.invert, name };
}

/** The "no dots" message, with advice that depends on the current options. */
function noDotsAdvice(
  o: { channel: string; inkOnly: boolean },
  sig: Signal,
  det: DotDetection,
  whole: boolean,
): string {
  const tips: string[] = [];
  // Whether a tip already says to set a region (the large-blobs one does).
  let regionTip = false;
  if (o.channel !== 'b' && o.channel !== 'y') tips.push(T('tip.channel'));
  else if (!sig.inkOnly) tips.push(T('tip.ink-only'));
  if (!det.auto) tips.push(T('tip.lower-threshold', { t: det.threshold }));
  else if (det.rejectedLarge > det.dots.length) {
    tips.push(T('tip.large-blobs', { count: det.rejectedLarge }));
    regionTip = true;
  } else
    tips.push(
      T('tip.fainter', { t: det.threshold, try: Math.max(1, Math.ceil(det.threshold / 2)) }),
    );
  if (whole && !regionTip) tips.push(T('tip.region'));
  return T('error.no-dots', { count: det.dots.length, t: det.threshold, tips: tips.join('; ') });
}

/** The fit picture: a view around the tile window (or the whole region when it is small). */
function overlayBlock(
  display: Display,
  rect: Rect,
  lattice: Lattice,
  grid: CellGrid,
  win: OverlayWindow | null,
  zoomOption: number,
  pitch: number,
  labels: OverlayLabel[],
): { blocks: Output[] } {
  let view: Rect = rect;
  if (win) {
    // The window plus a 3-cell margin (the numbers sit in the first one).
    const corners = [
      cellCenter(lattice, grid.i0 + win.x - 0.5, grid.j0 + win.y - 0.5),
      cellCenter(lattice, grid.i0 + win.x + win.w - 0.5, grid.j0 + win.y - 0.5),
      cellCenter(lattice, grid.i0 + win.x - 0.5, grid.j0 + win.y + win.h - 0.5),
      cellCenter(lattice, grid.i0 + win.x + win.w - 0.5, grid.j0 + win.y + win.h - 0.5),
    ];
    const xs = corners.map((c) => c.x);
    const ys = corners.map((c) => c.y);
    const bw = Math.max(...xs) - Math.min(...xs);
    const bh = Math.max(...ys) - Math.min(...ys);
    if (rect.w > 2.5 * bw || rect.h > 2.5 * bh) {
      const m = 3 * pitch;
      const x0 = Math.max(rect.x, Math.floor(Math.min(...xs) - m));
      const y0 = Math.max(rect.y, Math.floor(Math.min(...ys) - m));
      const x1 = Math.min(rect.x + rect.w, Math.ceil(Math.max(...xs) + m));
      const y1 = Math.min(rect.y + rect.h, Math.ceil(Math.max(...ys) + m));
      view = { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
    }
  }
  const blocks: Output[] = [];
  const wanted = zoomOption > 0 ? Math.min(16, Math.max(1, Math.round(zoomOption))) : 0;
  let zoom = wanted || autoZoom(view, pitch);
  while (zoom > 1 && Math.max(view.w, view.h) * zoom > OVERLAY_MAX_SIDE) zoom--;
  if (wanted && zoom < wanted)
    blocks.push({
      type: 'note',
      level: 'warn',
      text: T('warn.zoom-lowered', { asked: wanted, used: zoom, max: OVERLAY_MAX_SIDE }),
    });
  let image: RgbaImage;
  let label: string;
  if (Math.max(view.w, view.h) > OVERLAY_MAX_SIDE) {
    // Too big to draw cell by cell: the revealed region reduced, keeping the dots, no grid.
    image = poolLevel(display, rect, OVERLAY_MAX_SIDE);
    label = T('label.reduced', { w: image.width, h: image.height });
  } else {
    image = renderOverlay({ display, rect, view, zoom, lattice, grid, window: win, labels });
    label = win
      ? T(win.badRows.length || win.badCols.length ? 'label.fit-bad' : 'label.fit', { zoom })
      : T('label.fitted', { zoom });
  }
  blocks.push({ type: 'image', label, image, filename: 'printer-dots-fit.png' });
  return { blocks };
}
