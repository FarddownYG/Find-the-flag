/**
 * The "Instruction encoding" view of the executable analyzer: it runs the x86 direction-bit
 * detector over a binary's executable sections and reports the verdict, the extracted bitstream and
 * the reversed instructions. Format-independent: it is given the executable sections and the
 * bitness, so it works for ELF and PE alike.
 */
import type { Output } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import {
  asciiPreview,
  detectLengthHeader,
  type DualInstr,
  DUAL_MNEMONICS,
  type DualMnemonic,
  entropyOf,
  findFlags,
  latin1,
  packBits,
  scan,
} from './_exe-encoding';
import { instructionLengths } from './_exe-x86-decoder';

const T = toolT('exe-analyzer');
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ');

export interface ExecSection {
  name: string;
  /** File offset of the section's first byte. */
  offset: number;
  bytes: Uint8Array;
}

export interface EncodingOpts {
  bitOrder: string;
  invert: boolean;
  families: string;
}

/** Scan at most this many code bytes, and list at most this many reversed instructions. */
const MAX_CODE = 8_000_000;
const MAX_ROWS = 300;
const MAX_PREVIEW = 4096;
/** Below this many reversed forms there is no message to carry (and a few are compiler noise). */
const MIN_CHANNEL = 8;
/** A section this random is packed or encrypted: the direction-bit test needs plain code. */
const PACKED_ENTROPY = 7.2;

function enabledFamilies(spec: string): Set<DualMnemonic> {
  const words = spec
    .trim()
    .toLowerCase()
    .split(/[\s,]+/)
    .filter(Boolean);
  const known = words.filter((w): w is DualMnemonic =>
    (DUAL_MNEMONICS as readonly string[]).includes(w),
  );
  return new Set<DualMnemonic>(known.length ? known : DUAL_MNEMONICS);
}

export async function encodingView(
  sections: ExecSection[],
  bitness: 16 | 32 | 64,
  o: EncodingOpts,
): Promise<Output[]> {
  const enabled = enabledFamilies(o.families);
  const stats = new Map<DualMnemonic, { mnemonic: DualMnemonic; normal: number; reversed: number }>(
    DUAL_MNEMONICS.map((m) => [m, { mnemonic: m, normal: 0, reversed: 0 }]),
  );
  const instrs: (DualInstr & { fileOffset: number; section: string })[] = [];
  let reversed = 0;
  let regReg = 0;
  let scanned = 0;
  const hist = new Uint32Array(256);

  for (const sec of sections) {
    if (scanned >= MAX_CODE || sec.bytes.length === 0) continue;
    const slice = sec.bytes.subarray(0, MAX_CODE - scanned); // bound total memory and work
    const lengths = await instructionLengths(slice, bitness);
    const r = scan(slice, lengths, bitness, enabled);
    for (const ins of r.instructions) {
      instrs.push({ ...ins, fileOffset: sec.offset + ins.offset, section: sec.name });
    }
    for (const s of r.stats) {
      const acc = stats.get(s.mnemonic)!;
      acc.normal += s.normal;
      acc.reversed += s.reversed;
    }
    reversed += r.reversed;
    regReg += r.regReg;
    scanned += slice.length;
    for (const b of slice) hist[b]!++;
  }

  const out: Output[] = [];
  const entropy = entropyOf(hist, scanned);
  const packed = entropy > PACKED_ENTROPY;

  // --- verdict ---
  if (regReg === 0) {
    out.push({ type: 'note', level: 'info', text: T('enc.noRegReg') });
    return out;
  }
  if (packed) {
    // Random/packed bytes decode to ~50% reversed forms, just like a real channel would, so the
    // direction-bit test cannot speak for a section that is not plain compiled code.
    out.push({
      type: 'note',
      level: 'warn',
      text: T('enc.verdictPacked', { entropy: entropy.toFixed(2) }),
    });
  } else if (reversed === 0) {
    out.push({ type: 'note', level: 'info', text: T('enc.verdictClean', { regReg }) });
  } else if (reversed < MIN_CHANNEL) {
    out.push({ type: 'note', level: 'info', text: T('enc.verdictFew', { reversed, regReg }) });
  } else {
    out.push({ type: 'note', level: 'warn', text: T('enc.verdictHidden', { reversed, regReg }) });
  }

  const statRows = [...stats.values()].filter((s) => s.normal + s.reversed > 0);
  out.push({
    type: 'table',
    label: T('enc.statsLabel'),
    columns: [T('enc.colFamily'), T('enc.colNormal'), T('enc.colReversed')],
    rows: statRows.map((s) => [s.mnemonic, s.normal, s.reversed]),
    highlight: statRows.map((s, i) => (s.reversed >= 3 ? i : -1)).filter((i) => i >= 0),
  });

  // Nothing to extract unless enough instructions carry the reversed form.
  if (reversed < MIN_CHANNEL) return out;

  // --- extraction ---
  const bits = instrs.map((i) => i.bit);
  const stream = packBits(bits, o.bitOrder !== 'lsb', o.invert);
  out.push({
    type: 'kv',
    label: T('enc.streamLabel'),
    entries: [
      [T('enc.kvBits'), String(bits.length)],
      [T('enc.kvBytes'), String(stream.length)],
      [T('enc.kvOrder'), o.bitOrder === 'lsb' ? T('enc.lsb') : T('enc.msb')],
    ],
  });

  // The whole stream, always — never hidden behind a possibly-wrong length header.
  out.push({
    type: 'text',
    label: T('enc.decoded'),
    value: asciiPreview(stream.subarray(0, MAX_PREVIEW)),
  });

  // A length header that frames a readable body, when one is found, as a bonus.
  const [header] = detectLengthHeader(stream);
  if (header) {
    out.push({
      type: 'note',
      level: 'info',
      text: T('enc.header', {
        kind: header.kind,
        offset: header.headerOffset,
        value: header.value,
      }),
    });
    out.push({
      type: 'text',
      label: T('enc.body'),
      value: asciiPreview(stream.subarray(header.bodyStart, header.bodyStart + header.value)),
    });
  }

  const flags = findFlags(latin1(stream));
  if (flags.length) {
    out.push({ type: 'note', level: 'success', text: T('enc.flags', { flags: flags.join('  ') }) });
  }

  out.push({
    type: 'bytes',
    label: T('enc.download'),
    value: stream,
    filename: 'instruction-bits.bin',
  });

  // --- the reversed instructions, to see what was found ---
  const rev = instrs.filter((i) => i.bit === 1);
  const shown = rev.slice(0, MAX_ROWS);
  out.push({
    type: 'table',
    label:
      rev.length > shown.length
        ? T('enc.reversedFirst', { shown: shown.length, count: rev.length })
        : T('enc.reversedLabel', { count: rev.length }),
    columns: [T('enc.colOffset'), T('enc.colBytes'), T('enc.colDisasm')],
    rows: shown.map((i) => [`0x${i.fileOffset.toString(16)}`, hex(i.bytes), i.text]),
  });

  return out;
}
