/**
 * Binary detector for the analysis socle: look for an x86 instruction-encoding channel, a message
 * hidden in the DIRECTION bit of register-register mov/ALU instructions (89 vs 8b, 01 vs 03...).
 * It runs the Executable analyzer's own cores (decoder, scan, bit packing, length header), nothing
 * is reimplemented here.
 *
 * Input: an ELF or PE (the executable sections of an x86/x86-64 image) or a raw blob of machine
 * code (the whole input is code; both 32- and 64-bit are tried). Bits are read in file order,
 * most-significant bit first, then the other bit orders as a fallback.
 *
 * Confidence rule: 'confirmed' only for a recovered flag (the stream, or its length-framed body,
 * holds prefix{...}), never for a statistic and never because the file is a clean binary. Readable
 * text framed by a length header is only a 'candidate'. A packed / high-entropy region is skipped:
 * random bytes decode to about half reversed forms, which looks exactly like a channel.
 * Pure and deterministic: bytes in, findings out.
 */
import { latin1Decode } from '../lib/bytes';
import { Reader } from '../tools/forensics/_exe-bin';
import { isElf, parseElf } from '../tools/forensics/_exe-elf';
import {
  DUAL_MNEMONICS,
  detectLengthHeader,
  entropyOf,
  packBits,
  scan,
  type LengthHeader,
} from '../tools/forensics/_exe-encoding';
import { isPe, parsePe } from '../tools/forensics/_exe-pe';
import type { SectionRow } from '../tools/forensics/_exe-types';
import { instructionLengths } from '../tools/forensics/_exe-x86-decoder';
import { FLAG_RE } from '../tools/stego/_lsb-classify';
import { lazyFile } from './prepare';
import type { Finding } from './analyze';

type Bitness = 16 | 32 | 64;

interface Region {
  /** File offset of the region's first byte. */
  offset: number;
  bytes: Uint8Array;
  /** Bitness to try; several for a raw blob, where it is not declared. */
  bitness: Bitness[];
  label: string;
}

/** Scan at most this many code bytes per input (the decoder's work is linear in it). */
const MAX_CODE = 8_000_000;
/** Below this many reversed forms there is no message to carry (a few are compiler noise). */
const MIN_CHANNEL = 8;
/** A region this random is packed or encrypted: the direction-bit test needs plain code. */
const PACKED_ENTROPY = 7.2;
/** A framed readable body shorter than this is not worth a candidate. */
const MIN_CANDIDATE = 8;
/** At most this many non-flag findings are reported. */
const MAX_WEAK = 2;

const ORDERS: { msb: boolean; invert: boolean; label: string }[] = [
  { msb: true, invert: false, label: 'msb' },
  { msb: false, invert: false, label: 'lsb' },
  { msb: true, invert: true, label: 'msb inverted' },
  { msb: false, invert: true, label: 'lsb inverted' },
];

const ALL_FAMILIES: ReadonlySet<(typeof DUAL_MNEMONICS)[number]> = new Set(DUAL_MNEMONICS);

/** The x86 executable sections of an ELF / PE, or the whole input for a raw blob. */
async function regionsOf(bytes: Uint8Array, name?: string): Promise<Region[]> {
  const raw: Region = {
    offset: 0,
    bytes: bytes.subarray(0, MAX_CODE),
    bitness: [32, 64],
    label: 'raw code',
  };
  const isImage = isElf(bytes) || isPe(bytes);
  if (!isImage) return [raw];

  const r = new Reader(lazyFile(new Blob([bytes as BlobPart]), name));
  const info = isElf(bytes) ? await parseElf(r, false) : await parsePe(r, false);
  let layout: { sections: readonly SectionRow[]; bits: Bitness } | null = null;
  if ('header' in info) {
    const h = info.header;
    if (h && (h.machine === 3 || h.machine === 62))
      layout = { sections: info.sections, bits: h.bits };
  } else if (info.coff && (info.coff.machine === 0x14c || info.coff.machine === 0x8664)) {
    layout = { sections: info.sections, bits: info.opt?.plus ? 64 : 32 };
  }
  if (!layout) return [];
  const { sections, bits } = layout;

  const out: Region[] = [];
  let total = 0;
  for (const s of sections) {
    if (!s.exec || s.size <= 0 || total >= MAX_CODE) continue;
    const slice = (await r.read(s.offset, Math.min(s.size, MAX_CODE - total))).subarray(0);
    if (slice.length === 0) continue;
    total += slice.length;
    out.push({ offset: s.offset, bytes: slice, bitness: [bits], label: s.name || 'code' });
  }
  return out;
}

function histogramEntropy(code: Uint8Array): number {
  const hist = new Uint32Array(256);
  for (const b of code) hist[b]!++;
  return entropyOf(hist, code.length);
}

/** Every direction bit of the region at one bitness, in file order, plus how many were reversed. */
async function directionBits(
  code: Uint8Array,
  bitness: Bitness,
): Promise<{ bits: (0 | 1)[]; reversed: number }> {
  const lengths = await instructionLengths(code, bitness);
  const r = scan(code, lengths, bitness, ALL_FAMILIES);
  return { bits: r.instructions.map((i) => i.bit), reversed: r.reversed };
}

interface Decoded {
  flag?: string;
  /** Readable length-framed body, when there is one but no flag. */
  body?: string;
  size: number;
  detail: string;
}

/** What one bit order makes of the stream: a flag (anywhere in it, or in the framed body), or text. */
function readStream(stream: Uint8Array, order: string): Decoded | null {
  const header: LengthHeader | undefined = detectLengthHeader(stream)[0];
  const framed = header
    ? latin1Decode(stream.subarray(header.bodyStart, header.bodyStart + header.value))
    : undefined;
  const flag =
    (framed !== undefined ? FLAG_RE.exec(framed)?.[0] : undefined) ??
    FLAG_RE.exec(latin1Decode(stream))?.[0];
  const how = header ? `${order} · ${header.kind} length header` : order;
  if (flag) return { flag, size: flag.length, detail: how };
  if (framed !== undefined && framed.length >= MIN_CANDIDATE) {
    return { body: framed, size: framed.length, detail: how };
  }
  return null;
}

export async function detectBinary(bytes: Uint8Array, name?: string): Promise<Finding[]> {
  if (bytes.length < 16) return [];
  const regions = await regionsOf(bytes, name);
  const out: Finding[] = [];
  const flags = new Set<string>();
  const bodies = new Set<string>();
  let weak = 0;

  for (const region of regions) {
    if (histogramEntropy(region.bytes) > PACKED_ENTROPY) continue;
    for (const bitness of region.bitness) {
      const { bits, reversed } = await directionBits(region.bytes, bitness);
      if (reversed < MIN_CHANNEL) continue;
      for (const o of ORDERS) {
        const decoded = readStream(packBits(bits, o.msb, o.invert), o.label);
        if (!decoded) continue;
        const detail = `x86 instruction encoding · ${region.label} · ${bitness}-bit · ${decoded.detail}`;
        if (decoded.flag !== undefined) {
          if (flags.has(decoded.flag)) continue;
          flags.add(decoded.flag);
          out.push({
            kind: 'flag',
            confidence: 'confirmed',
            title: decoded.flag,
            detail,
            flag: decoded.flag,
            offset: region.offset,
            size: decoded.size,
          });
        } else if (decoded.body !== undefined) {
          if (bodies.has(decoded.body) || weak >= MAX_WEAK) continue;
          bodies.add(decoded.body);
          weak++;
          out.push({
            kind: 'stego-x86-encoding',
            confidence: 'candidate',
            title: 'readable text in instruction encoding',
            detail,
            offset: region.offset,
            size: decoded.size,
          });
        }
      }
    }
  }
  return out;
}
