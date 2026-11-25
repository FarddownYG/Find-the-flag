import { defineTool, number, select, text, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output, RgbaImage } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import { latin1Decode, toHex } from '../../lib/bytes';
import { plaintextScore } from '../../lib/english';
import { classifyStream, FLAG_RE, KIND_TIER, preview } from './_lsb-classify';
import {
  capacity,
  type CodeTable,
  channelName,
  decode,
  encode,
  type IndicatorMode,
  type PitSettings,
  type PixelTrace,
  type Slot,
  slotChannels,
} from './_pit';

const T = toolT('pit');

const MAX_PIXELS = 30_000_000;
/** Auto mode decodes only this many body bytes per combination when ranking. */
const PREVIEW_BYTES = 96;
const MAX_COMBOS = 20_000;
const MAX_START_ROWS = 6;

const INDICATORS: IndicatorMode[] = ['r', 'g', 'b', 'rotate'];
/** The code tables auto mode tries: 01/10 on channel 1/2 or swapped, 11 in either order. */
const AUTO_TABLES: CodeTable[] = [
  ['none', 'c1', 'c2', 'c1c2'],
  ['none', 'c1', 'c2', 'c2c1'],
  ['none', 'c2', 'c1', 'c1c2'],
  ['none', 'c2', 'c1', 'c2c1'],
];
const AUTO_HEADERS: { bytes: number; endian: 'be' | 'le' }[] = [
  { bytes: 8, endian: 'be' },
  { bytes: 4, endian: 'be' },
  { bytes: 8, endian: 'le' },
  { bytes: 4, endian: 'le' },
];

const SLOT_CHOICES = [
  { value: 'none', label: 'Nothing' },
  { value: 'c1', label: 'Channel 1' },
  { value: 'c2', label: 'Channel 2' },
  { value: 'c1c2', label: 'Channel 1, then 2' },
  { value: 'c2c1', label: 'Channel 2, then 1' },
] as const;
const SLOT_HINT =
  'Channel 1 and 2 are the two channels that are not the indicator, in R, G, B order (indicator G: channel 1 = R, channel 2 = B).';
const manual = (v: Record<string, unknown>) => v.mode !== 'auto';

const latin1 = (b: Uint8Array) => latin1Decode(b);

function formatNote(bytes: Uint8Array): Output | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return { type: 'note', level: 'warn', text: T('note.jpeg') };
  }
  return null;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return toHex(new Uint8Array(d));
}

// ---------- labels ----------

function slotText(slot: Slot, indicator: IndicatorMode): string {
  if (slot === 'none') return '–';
  const fixed = indicator !== 'rotate';
  const ind = fixed ? ({ r: 0, g: 1, b: 2 } as const)[indicator] : 0;
  if (fixed) return slotChannels(slot, ind).map(channelName).join('→');
  return { c1: 'c1', c2: 'c2', c1c2: 'c1→c2', c2c1: 'c2→c1' }[slot];
}

const tableText = (t: CodeTable, indicator: IndicatorMode): string =>
  t.map((slot, i) => `${i.toString(2).padStart(2, '0')}:${slotText(slot, indicator)}`).join(' ');

function settingsLabel(s: PitSettings): string {
  return T('value.settings', {
    indicator: s.indicator === 'rotate' ? T('indicator.rotate') : s.indicator.toUpperCase(),
    table: tableText(s.codeTable, s.indicator),
    bits: s.bitsPerChannel,
    order: s.bitOrder === 'msb' ? 'MSB' : 'LSB',
    header: T('value.header', {
      bytes: s.header.bytes,
      endian: T(`endian.${s.header.endian}`),
      pixel: s.header.atPixel,
    }),
    start: s.startMode === 'row' ? T('start.row', { row: s.startRow }) : T('start.after'),
  });
}

// ---------- scoring ----------

const BIGRAMS = new Set(
  'th he in er an re on at en nd ti es or te of ed is it al ar st to nt ng se ha as ou io le ve co me de hi ri ro ic ne ea ra ce li ch ll be ma si om ur'.split(
    ' ',
  ),
);

function bigramShare(txt: string): number {
  const low = txt.toLowerCase();
  let hit = 0;
  for (let i = 0; i + 1 < low.length; i++) if (BIGRAMS.has(low.slice(i, i + 2))) hit++;
  return low.length > 1 ? hit / (low.length - 1) : 0;
}

interface Score {
  score: number;
  /** Looks like a real message, not noise. */
  plausible: boolean;
}

/** ASCII (top bit 0) + printable + English-ness of a decoded body preview. */
function scoreBody(body: Uint8Array): Score {
  const n = body.length;
  if (n < 4) return { score: 0, plausible: false };
  let ascii = 0;
  let printable = 0;
  for (const b of body) {
    if (b < 0x80) ascii++;
    if ((b >= 0x20 && b < 0x7f) || b === 9 || b === 10 || b === 13) printable++;
  }
  const txt = latin1(body);
  const hit = classifyStream(body);
  const tier = hit ? KIND_TIER[hit.kind] : 0;
  const score =
    (ascii / n) * 200 +
    (printable / n) * 300 +
    plaintextScore(txt) +
    bigramShare(txt) * 100 +
    (FLAG_RE.test(txt) ? 500 : 0) +
    tier * 1000;
  const plausible = ascii / n >= 0.95 && printable / n >= 0.9 && new Set(body).size >= 3;
  return { score, plausible };
}

// ---------- zones ----------

/** Mean absolute step between horizontal neighbours, over R, G and B, for each row. */
function rowRoughness(image: RgbaImage): number[] {
  const { width: w, height: h, data } = image;
  const out: number[] = [];
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let x = 1; x < w; x++) {
      for (let c = 0; c < 3; c++) {
        sum += Math.abs(data[(y * w + x) * 4 + c]! - data[(y * w + x - 1) * 4 + c]!);
      }
    }
    out.push(w > 1 ? sum / ((w - 1) * 3) : 0);
  }
  return out;
}

/**
 * Rows where a noisier zone starts (the carrier rows differ from the calm cover): the first row of
 * each run above the midpoint between the calm and the noisy rows, and the row after it (the
 * header usually fills the first row and the body starts below).
 */
function detectedRows(image: RgbaImage): number[] {
  const r = rowRoughness(image);
  if (r.length < 4) return [];
  const sorted = [...r].sort((a, b) => a - b);
  const lo = sorted[Math.floor(0.1 * (r.length - 1))]!;
  const hi = sorted[Math.floor(0.9 * (r.length - 1))]!;
  if (hi < lo * 1.8 + 0.3) return [];
  const t = (lo + hi) / 2;
  const rows: number[] = [];
  for (let y = 0; y < r.length && rows.length < MAX_START_ROWS; y++) {
    if (r[y]! > t && (y === 0 || r[y - 1]! <= t)) rows.push(y, y + 1);
  }
  return rows.filter((y) => y < image.height).slice(0, MAX_START_ROWS);
}

// ---------- explanation ----------

function pythonScript(s: PitSettings): string {
  const slots = JSON.stringify(s.codeTable);
  const ind = s.indicator === 'rotate' ? 'rotate' : s.indicator;
  const sr = s.startMode === 'row' ? s.startRow : -1;
  return [
    'from PIL import Image',
    "im = Image.open('stego.png').convert('RGB'); w, h = im.size; px = im.load()",
    `IND = '${ind}'  # r g b, or rotate (R, G, B, R ... one step per pixel)`,
    `TABLE = ${slots}  # slot of the codes 00, 01, 10, 11`,
    `BPC = ${s.bitsPerChannel}; MSB = ${s.bitOrder === 'msb' ? 'True' : 'False'}`,
    `HEADER = ${s.header.bytes}; ENDIAN = '${s.header.endian === 'be' ? 'big' : 'little'}'; AT = ${s.header.atPixel}`,
    `START_ROW = ${sr}  # -1 = right after the header`,
    'def chans(ind, slot):',
    '    a, b = [c for c in range(3) if c != ind]  # channel 1, channel 2',
    "    return {'none': [], 'c1': [a], 'c2': [b], 'c1c2': [a, b], 'c2c1': [b, a]}[slot]",
    'def read(first, n, rot0):',
    '    out = bytearray(n); pos = 0; p = first',
    '    while pos < n * 8 and p < w * h:',
    '        rgb = px[p % w, p // w]',
    "        ind = (rot0 + p - first) % 3 if IND == 'rotate' else 'rgb'.index(IND)",
    '        for c in chans(ind, TABLE[rgb[ind] & 3]):',
    '            v = rgb[c] & ((1 << BPC) - 1)',
    '            for i in range(BPC):',
    '                if pos < n * 8:',
    '                    bit = (v >> (BPC - 1 - i if MSB else i)) & 1',
    '                    out[pos >> 3] |= bit << (7 - (pos & 7) if MSB else (pos & 7)); pos += 1',
    '        p += 1',
    '    return bytes(out), p',
    'hdr, nxt = read(AT, HEADER, 0)',
    'n = min(int.from_bytes(hdr, ENDIAN), w * h)',
    'start = max(START_ROW * w, nxt) if START_ROW >= 0 else nxt',
    'body, _ = read(start, n, n % 2)',
    'print(n, body)',
  ].join('\n');
}

const bin = (n: number, w: number) => n.toString(2).padStart(w, '0');

function traceRows(trace: PixelTrace[], s: PitSettings): (string | number)[][] {
  return trace
    .slice(0, 3)
    .map((p) => [
      `(${p.x}, ${p.y})`,
      `${channelName(p.indicator)} = ${bin(p.indicatorValue, 8)}`,
      bin(p.code, 2),
      p.channels.length ? p.channels.map(channelName).join(' → ') : '–',
      p.bits.length ? p.bits.join('') : '–',
      p.channels.length ? `${s.bitsPerChannel} × ${p.channels.length}` : '0',
    ]);
}

function explain(s: PitSettings, trace: PixelTrace[]): Output[] {
  return [
    { type: 'kv', label: T('label.settings'), entries: [[T('kv.how'), settingsLabel(s)]] },
    {
      type: 'table',
      label: T('label.pixels'),
      columns: [
        T('col.pixel'),
        T('col.indicator'),
        T('col.code'),
        T('col.channels'),
        T('col.bits'),
        T('col.size'),
      ],
      rows: traceRows(trace, s),
    },
    { type: 'text', label: T('label.python'), value: pythonScript(s) },
    { type: 'note', level: 'info', text: T('note.sheet') },
  ];
}

// ---------- tool ----------

export default defineTool({
  id: 'pit',
  name: 'PIT steganography (Pixel Indicator Technique)',
  category: 'stego',
  description:
    "Read or hide a message with Gutub's Pixel Indicator Technique: one colour channel of each pixel is an indicator whose two low bits say which of the other two channels carry the data. Pick the indicator, the code table, the header and where the body starts (often row 1), or let auto mode try the common variants and rank them.",
  tags: [
    'pit',
    'pixel indicator',
    'pixel indicator technique',
    'gutub',
    'indicator channel',
    'image steganography',
    'rgb',
    'header length',
  ],
  input: 'image',
  placeholder: 'Drop a lossless image (PNG, BMP, GIF, PPM): PIT reads exact pixel values',
  options: {
    mode: toggle(
      'Mode',
      [
        { value: 'auto', label: 'Auto (try the variants)' },
        { value: 'decode', label: 'Decode' },
        { value: 'encode', label: 'Encode' },
      ],
      'auto',
    ),
    indicator: select(
      'Indicator channel',
      [
        { value: 'r', label: 'Red' },
        { value: 'g', label: 'Green' },
        { value: 'b', label: 'Blue' },
        { value: 'rotate', label: 'Rotating (R, G, B, R…)' },
      ],
      'g',
      {
        hint: 'Rotating moves to the next channel at each pixel; the body starts on R for an even length and G for an odd one.',
        showIf: manual,
      },
    ),
    code00: select('Code 00', SLOT_CHOICES, 'none', { hint: SLOT_HINT, showIf: manual }),
    code01: select('Code 01', SLOT_CHOICES, 'c1', { showIf: manual }),
    code10: select('Code 10', SLOT_CHOICES, 'c2', { showIf: manual }),
    code11: select('Code 11', SLOT_CHOICES, 'c1c2', { showIf: manual }),
    bitsPerChannel: number('Bits per channel', 2, {
      min: 1,
      max: 4,
      hint: 'Low bits of each selected channel that carry data.',
      showIf: manual,
    }),
    bitOrder: toggle(
      'Bit order',
      [
        { value: 'msb', label: 'MSB first' },
        { value: 'lsb', label: 'LSB first' },
      ],
      'msb',
      { showIf: manual },
    ),
    headerBytes: number('Header size (bytes)', 8, {
      min: 1,
      max: 8,
      hint: 'The message length, stored in clear before the body.',
      showIf: manual,
    }),
    headerEndian: toggle(
      'Header byte order',
      [
        { value: 'be', label: 'Big-endian' },
        { value: 'le', label: 'Little-endian' },
      ],
      'be',
      { showIf: manual },
    ),
    headerPixel: number('Header starts at pixel', 0, {
      min: 0,
      hint: 'Pixel index in reading order (row by row), 0 = top-left.',
      showIf: manual,
    }),
    startMode: toggle(
      'Body starts',
      [
        { value: 'after', label: 'Right after the header' },
        { value: 'row', label: 'At a row' },
      ],
      'after',
      { showIf: manual },
    ),
    startRow: number('Body start row', 1, {
      min: 0,
      hint: 'Counted from 0 at the top. The body often starts on row 1, not right after the header.',
      showIf: (v) => manual(v) && v.startMode === 'row',
    }),
    message: text('Message to hide', 'FTF{pit}', { showIf: (v) => v.mode === 'encode' }),
  },
  examples: [
    {
      label: 'Auto-find a message behind a green indicator whose body starts on row 1',
      input: { sample: 'stego-pit.png' },
      expect: 'FTF{pit_indicator}',
    },
  ],
  async run({ image, bytes }, o): Promise<Output[]> {
    if (image.width * image.height > MAX_PIXELS) throw new ToolError(T('error.tooLarge'));
    const out: Output[] = [];
    const warn = formatNote(bytes);
    if (warn) out.push(warn);
    out.push({
      type: 'kv',
      label: T('label.file'),
      entries: [
        ['SHA-256', await sha256(bytes)],
        [T('kv.size'), `${image.width} × ${image.height}`],
      ],
    });

    const clamp = (v: number, lo: number, hi: number, d: number) =>
      Math.min(hi, Math.max(lo, Number.isFinite(v) ? Math.round(v) : d));
    const manualSettings = (): PitSettings => ({
      indicator: o.indicator,
      codeTable: [o.code00, o.code01, o.code10, o.code11],
      bitsPerChannel: clamp(o.bitsPerChannel, 1, 4, 2),
      bitOrder: o.bitOrder,
      header: {
        bytes: clamp(o.headerBytes, 1, 8, 8),
        endian: o.headerEndian,
        atPixel: clamp(o.headerPixel, 0, MAX_PIXELS, 0),
      },
      startMode: o.startMode,
      startRow: clamp(o.startRow, 0, 1_000_000, 1),
    });

    if (o.mode === 'encode') {
      const s = manualSettings();
      const msg = new TextEncoder().encode(o.message);
      if (!msg.length) throw new ToolError(T('error.empty'));
      let stego: RgbaImage;
      try {
        stego = encode(image, msg, s);
      } catch {
        throw new ToolError(T('error.fit', { capacity: capacity(image, s) }));
      }
      out.push({ type: 'image', label: T('label.stego'), image: stego, filename: 'pit-stego.png' });
      out.push({ type: 'note', level: 'success', text: T('note.encoded', { n: msg.length }) });
      out.push({ type: 'note', level: 'info', text: T('note.encodeRule') });
      return out;
    }

    if (o.mode === 'decode') {
      const s = manualSettings();
      const r = decode(image, s);
      if (r.header === 0 || r.header > image.width * image.height) {
        out.push({ type: 'note', level: 'warn', text: T('note.badHeader', { n: r.header }) });
      }
      out.push({
        type: 'kv',
        label: T('label.header'),
        entries: [
          [T('kv.length'), String(r.header)],
          [
            T('kv.bodyStart'),
            T('value.pixel', {
              pixel: r.bodyStart,
              x: r.bodyStart % image.width,
              y: Math.floor(r.bodyStart / image.width),
            }),
          ],
        ],
      });
      out.push({ type: 'text', label: T('label.decoded'), value: preview(r.body, 512) });
      if (r.body.length) {
        out.push({
          type: 'bytes',
          label: T('label.bytes'),
          value: r.body,
          filename: 'pit-body.bin',
        });
      }
      out.push(...explain(s, r.trace));
      return out;
    }

    // --- auto ---
    const rows = detectedRows(image);
    const starts: Pick<PitSettings, 'startMode' | 'startRow'>[] = [
      { startMode: 'after', startRow: 0 },
      { startMode: 'row', startRow: 0 },
      { startMode: 'row', startRow: 1 },
      ...rows.map((startRow) => ({ startMode: 'row' as const, startRow })),
    ];
    const combos =
      INDICATORS.length * AUTO_TABLES.length * 2 * 2 * starts.length * AUTO_HEADERS.length;
    if (combos > MAX_COMBOS) throw new ToolError(T('error.combos', { n: combos }));

    const seen = new Set<string>();
    const ranked: { s: PitSettings; score: Score; prev: Uint8Array }[] = [];
    for (const indicator of INDICATORS) {
      for (const codeTable of AUTO_TABLES) {
        for (const bitsPerChannel of [2, 1]) {
          for (const bitOrder of ['msb', 'lsb'] as const) {
            for (const h of AUTO_HEADERS) {
              for (const st of starts) {
                const s: PitSettings = {
                  indicator,
                  codeTable,
                  bitsPerChannel,
                  bitOrder,
                  header: { ...h, atPixel: 0 },
                  ...st,
                };
                const r = decode(image, s, PREVIEW_BYTES);
                // A header that announces more than the image holds is noise, not a length.
                const room = Math.floor(
                  ((image.width * image.height - r.bodyStart) * 2 * bitsPerChannel) / 8,
                );
                if (r.header < 1 || r.header > room) continue;
                const key = `${indicator}|${codeTable.join()}|${bitsPerChannel}|${bitOrder}|${h.bytes}${h.endian}|${r.bodyStart}`;
                if (seen.has(key)) continue;
                seen.add(key);
                const score = scoreBody(r.body);
                if (score.score > 0) ranked.push({ s, score, prev: r.body });
              }
            }
          }
        }
      }
    }
    ranked.sort((a, b) => b.score.score - a.score.score);
    const top = ranked.slice(0, 5);
    const best = top[0];
    if (!best || !best.score.plausible) {
      out.push({ type: 'note', level: 'warn', text: T('note.none', { n: seen.size }) });
      return out;
    }
    out.push({
      type: 'table',
      label: T('label.top'),
      columns: [T('col.settings'), T('col.score'), T('col.preview')],
      rows: top.map((c) => [settingsLabel(c.s), c.score.score.toFixed(0), preview(c.prev, 40)]),
      highlight: [0],
    });
    out.push({ type: 'note', level: 'success', text: T('note.found', { n: seen.size }) });
    const r = decode(image, best.s);
    out.push({ type: 'text', label: T('label.decoded'), value: preview(r.body, 512) });
    if (r.body.length) {
      out.push({ type: 'bytes', label: T('label.bytes'), value: r.body, filename: 'pit-body.bin' });
    }
    out.push(...explain(best.s, r.trace));
    return out;
  },
});
