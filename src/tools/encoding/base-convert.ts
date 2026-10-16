import { defineTool, select, toggle } from '../../core/define';
import type { Output } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import { isValidUtf8, latin1Decode, printableRatio, utf8Decode, utf8Encode } from '../../lib/bytes';
import { bigintToBytes } from '../misc/number-base';
import {
  analyze,
  write,
  type Analysis,
  type InputChoice,
  type Radix,
  type Reading,
  type WriteOptions,
  type Written,
} from './_base-convert';
import binaryTool from './binary';
import hexTool from './hex';
import { bytesResult } from './_common';

const T = toolT('base-convert');

const CHOICE: Record<Radix, InputChoice> = { 2: '2', 8: '8', 10: '10', 16: '16' };
const PREVIEW = 100;
/** Readings named in the "also valid" note: the table below lists them all. */
const ALSO = 4;

/** The reading as a short phrase: "Octal character codes", "Hex number"... */
function readingLabel(r: Reading): string {
  if (r.kind === 'text') return T('reading.text');
  return r.radices
    .map((radix) => {
      if (r.kind === 'codes' && radix === 2) return T('reading.codes.2', { bits: r.bits ?? 8 });
      return T(`reading.${r.kind}.${radix}`);
    })
    .join(' = ');
}

const flat = (s: string): string =>
  s.replace(/\p{Cc}/gu, (c) => (c === '\n' ? '↵' : '·')).replace(/\s+/g, ' ');
const clip = (s: string, max = PREVIEW): string => (s.length > max ? `${s.slice(0, max)}…` : s);

/** What the reading gives, for the comparison table. */
function decodedCell(r: Reading): string {
  if (r.text !== null) return clip(flat(r.text));
  if (r.kind === 'number') return T('cell.value', { value: clip(r.values[0]!.toString(), 16) });
  return clip(r.values.join(' '), 60);
}

function readingsTable(readings: Reading[]): Output {
  return {
    type: 'table',
    label: T('label.readings'),
    columns: [T('col.reading'), T('col.decoded'), T('col.score')],
    rows: readings.map((r) => [readingLabel(r), decodedCell(r), r.score]),
    highlight: [0],
  };
}

/** The four bases as copyable blocks. `bytes`: the groups are bytes (8-bit, 3 octal digits...). */
function baseBlocks(w: Written, bits: 7 | 8, bytes: boolean): Output[] {
  const binaryLabel = bytes
    ? T('label.binaryGroups', { bits: w.over7 ? 8 : bits })
    : T('label.binary');
  return [
    { type: 'text', label: binaryLabel, value: w.binary },
    { type: 'text', label: T('label.octal'), value: w.octal },
    { type: 'text', label: T('label.decimal'), value: w.decimal },
    { type: 'text', label: T('label.hex'), value: w.hex },
  ];
}

const bitLength = (n: bigint): number => (n === 0n ? 1 : (n < 0n ? -n : n).toString(2).length);

/** A character for a code point that is worth showing (printable, not a lone surrogate). */
function characterOf(n: bigint): string | null {
  if (n < 0x20n || n > 0x10ffffn || (n >= 0x7fn && n < 0xa0n)) return null;
  if (n >= 0xd800n && n < 0xe000n) return null;
  const ch = String.fromCodePoint(Number(n));
  return /[\p{L}\p{N}\p{P}\p{S}]/u.test(ch) ? ch : null;
}

function numberFacts(value: bigint): Output[] {
  const bits = bitLength(value);
  const entries: [string, string][] = [
    [T('kv.bits'), String(bits)],
    [T('kv.bytes'), String(Math.ceil(bits / 8))],
  ];
  const ch = characterOf(value);
  if (ch !== null) entries.push([T('kv.character'), ch]);
  const out: Output[] = [{ type: 'kv', label: T('label.details'), entries }];
  if (value >= 0n) {
    const bytes = bigintToBytes(value);
    if (bytes.length >= 2 && printableRatio(bytes) >= 0.9) {
      const text = isValidUtf8(bytes) ? utf8Decode(bytes) : latin1Decode(bytes);
      out.push({ type: 'text', label: T('label.bigEndian'), value: text });
    }
  }
  return out;
}

function summary(analysis: Analysis): Output[] {
  const [best, ...others] = analysis.readings;
  if (!best) return [];
  const level = { high: 'success', medium: 'info', low: 'warn' } as const;
  const out: Output[] = [
    {
      type: 'note',
      level: level[analysis.confidence],
      text: T('note.read', {
        reading: readingLabel(best),
        confidence: T(`confidence.${analysis.confidence}`),
      }),
    },
  ];
  if (others.length) {
    const shown = others.slice(0, ALSO).map(readingLabel);
    out.push({
      type: 'note',
      level: 'info',
      text: T('note.also', { others: shown.join(' · ') + (others.length > ALSO ? ' …' : '') }),
    });
  }
  return out;
}

function run(input: string, choice: InputChoice, o: WriteOptions): Output[] {
  const analysis = analyze(input, choice, o.width);
  const best = analysis.readings[0]!;
  const out: Output[] = [];
  const isText = best.kind === 'text';
  const lone = best.kind === 'number';

  // Plain text needs no verdict; anything that could be read several ways does.
  if (!isText || analysis.readings.length > 1) out.push(...summary(analysis));

  if (best.kind === 'codes' && best.text !== null) {
    const label = T('label.decoded');
    if (best.bytes) {
      out.push(...bytesResult(best.bytes).map((b) => (b.type === 'bytes' ? { ...b, label } : b)));
    } else out.push({ type: 'text', label, value: best.text });
    if (best.score < 35) out.push({ type: 'note', level: 'info', text: T('note.notText') });
  }

  if (isText) {
    const bytes = utf8Encode(best.text ?? '');
    out.push({
      type: 'kv',
      label: T('label.details'),
      entries: [
        [T('kv.characters'), String([...(best.text ?? '')].length)],
        [T('kv.bytes'), String(bytes.length)],
      ],
    });
    if (bytes.length !== [...(best.text ?? '')].length) {
      out.push({ type: 'note', level: 'info', text: T('note.utf8') });
    }
  }

  const written = write(best.values, o, !lone);
  out.push(...baseBlocks(written, o.width, !lone && best.bytes !== null));
  if (written.over7) out.push({ type: 'note', level: 'warn', text: T('note.over7') });

  if (lone) out.push(...numberFacts(best.values[0]!));
  if (analysis.readings.length > 1) out.push(readingsTable(analysis.readings));
  if (best.kind === 'number' || best.kind === 'numbers') {
    out.push({
      type: 'actions',
      label: T('label.moreBases'),
      actions: [
        { label: T('action.numberBase'), options: {}, open: { tool: 'number-base', text: input } },
      ],
    });
  }
  return out;
}

export default defineTool({
  id: 'base-convert',
  name: 'Binary / Octal / Decimal / Hex',
  category: 'encoding',
  description:
    'Paste text or numbers: it works out whether they are binary, octal, decimal or hex and shows the text and every base side by side.',
  tags: [
    'octal',
    'decimal',
    'base 8',
    'base 10',
    'base 2',
    'base 16',
    'converter',
    'conversion',
    'base converter',
    'radix',
    'ascii',
    'ascii codes',
    'ascii table',
    'text to binary',
    'binary to text',
    'dec2bin',
    'bin2dec',
    'hex2dec',
    'bin oct dec hex',
    'bases',
    'hexadecimal converter',
    'convertisseur',
    'binaire / octal / décimal / hexa',
    'code ascii',
  ],
  input: 'text',
  placeholder: 'FTF{ok}   or   106 124 106   or   70 84 70   or   0x46 0x54 0x46   or   01000110',
  options: {
    input: select(
      'Input',
      [
        { value: 'auto', label: 'Auto' },
        { value: 'text', label: 'Text' },
        { value: '2', label: 'Binary (2)' },
        { value: '8', label: 'Octal (8)' },
        { value: '10', label: 'Decimal (10)' },
        { value: '16', label: 'Hex (16)' },
      ],
      'auto',
      {
        hint: 'Auto: text stays text, a list of numbers is read in every base that fits and ranked by the text it gives.',
      },
    ),
    width: toggle('Bits per group', ['8', '7']),
    separator: select(
      'Output separator',
      [
        { value: 'space', label: 'Space' },
        { value: 'comma', label: 'Comma' },
        { value: 'newline', label: 'Newline' },
        { value: 'none', label: 'None' },
      ],
      'space',
    ),
    hexCase: toggle('Hex letters', [
      { value: 'lower', label: 'abc' },
      { value: 'upper', label: 'ABC' },
    ]),
  },
  examples: [
    {
      label: 'Text in every base',
      input: 'FTF{ok}',
      expect: '46 54 46 7b 6f 6b 7d',
    },
    {
      label: 'Octal codes',
      input: '106 124 106 173 157 143 164 141 154 175',
      expect: 'FTF{octal}',
    },
    {
      label: 'Decimal codes',
      input: '70 84 70 123 100 101 99 125',
      expect: 'FTF{dec}',
    },
    {
      label: 'Hex bytes with 0x',
      input: '0x46 0x54 0x46 0x7b 0x68 0x65 0x78 0x7d',
      expect: 'FTF{hex}',
    },
    {
      label: 'Binary, no spaces',
      input: '0100011001010100010001100111101101100010011010010110111001111101',
      expect: 'FTF{bin}',
    },
    {
      label: '7-bit binary',
      input: '1000110 1010100 1000110 1111011 1100010 1100001 1110011 1100101 1111101',
      options: { width: '7' },
      expect: 'FTF{base}',
    },
    {
      label: 'Several readings: 101 102 103',
      input: '101 102 103',
      expect: 'efg',
    },
    {
      label: 'A huge number',
      input: '2511413510842060413510119088141712512283210298218286115709',
      expect: 'flag{rsa_small_e_attack}',
    },
  ],
  detect({ text }) {
    const t = text?.trim() ?? '';
    if (t.length < 5 || t.length > 20_000) return null;
    // Cheap pre-check: only digits, hex letters, prefixes and separators.
    if (!/^[0-9a-fA-FxXoObBuU+\\\s,;:|_.-]+$/.test(t)) return null;
    let analysis: Analysis;
    try {
      analysis = analyze(t, 'auto', 8);
    } catch {
      return null; // not a list of codes: the other tools decide
    }
    const best = analysis.readings[0]!;
    if (best.kind !== 'codes' || best.score < 50) return null;
    let score = { high: 0.62, medium: 0.5, low: 0.4 }[analysis.confidence];
    // The Binary and Hex tools know their own shapes better: stay below them when they match.
    const sample = { text: t, bytes: utf8Encode(t) };
    for (const peer of [binaryTool, hexTool]) {
      const found = peer.detect?.(sample);
      if (found) score = Math.min(score, found.score - 0.05);
    }
    if (score < 0.25) return null;
    return {
      score,
      options: { input: CHOICE[best.radices[0]!] },
      reason: T('detect.codes', { reading: readingLabel(best) }),
    };
  },
  run: (text, { input, width, separator, hexCase }) =>
    run(text, input, {
      width: width === '7' ? 7 : 8,
      separator,
      upper: hexCase === 'upper',
    }),
});
