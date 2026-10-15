import { bool, defineTool, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import { utf8Decode } from '../../lib/bytes';
import { bytesResult, showChar } from './_common';

const T = toolT('bubblebabble');

const VOWELS = 'aeiouy';
/** 16 consonants for data, and "x" (index 16) only as the end mark of an even-length string. */
const CONSONANTS = 'bcdfghklmnprstvzx';

/**
 * Bubble Babble (Antti Huima, 2000; the form of `ssh-keygen -B`): pronounceable five-letter
 * groups, with a checksum that runs through the whole string. The empty string is "xexax".
 */
export function bubbleBabbleEncode(bytes: Uint8Array): string {
  let seed = 1;
  const rounds = Math.floor(bytes.length / 2) + 1;
  let out = 'x';
  for (let i = 0; i < rounds; i++) {
    if (i + 1 < rounds || bytes.length % 2 !== 0) {
      const b0 = bytes[2 * i]!;
      out +=
        VOWELS[(((b0 >> 6) & 3) + seed) % 6]! +
        CONSONANTS[(b0 >> 2) & 15]! +
        VOWELS[((b0 & 3) + Math.floor(seed / 6)) % 6]!;
      if (i + 1 < rounds) {
        const b1 = bytes[2 * i + 1]!;
        out += `${CONSONANTS[(b1 >> 4) & 15]!}-${CONSONANTS[b1 & 15]!}`;
        seed = (seed * 5 + b0 * 7 + b1) % 36;
      }
    } else {
      out += VOWELS[seed % 6]! + CONSONANTS[16]! + VOWELS[Math.floor(seed / 6)]!;
    }
  }
  return `${out}x`;
}

export interface BubbleProblem {
  /** 1-based group (a vowel-consonant-vowel + consonant-consonant block) the checksum disagrees with. */
  group: number;
  /** Positions (1-based, in the text as given) of the letters of that group. */
  from: number;
  to: number;
}

export interface BubbleResult {
  bytes: Uint8Array;
  /** Where the checksum chain does not match (only with `lenient`; otherwise it throws). */
  problems: BubbleProblem[];
}

/** Case-insensitive; dashes and whitespace are ignored. Positions count the text as given. */
export function bubbleBabbleDecode(text: string, lenient = false): BubbleResult {
  const letters: { ch: string; pos: number }[] = [];
  let pos = 0;
  for (const raw of text) {
    pos++;
    if (raw === '-' || /\s/.test(raw)) continue;
    letters.push({ ch: raw.toLowerCase(), pos });
  }
  if (!letters.length) throw new ToolError(T('error.empty'));
  const first = letters[0]!;
  const last = letters[letters.length - 1]!;
  if (first.ch !== 'x') {
    throw new ToolError(T('error.start', { char: showChar(text[first.pos - 1]), pos: first.pos }));
  }
  if (letters.length < 2 || last.ch !== 'x') {
    throw new ToolError(T('error.end', { char: showChar(text[last.pos - 1]), pos: last.pos }));
  }
  const body = letters.slice(1, -1);
  if (body.length < 3 || (body.length - 3) % 5 !== 0) {
    throw new ToolError(T('error.length', { count: body.length }));
  }

  // Every letter is a vowel or a consonant, and must sit where its kind belongs.
  const kinds = ['v', 'c', 'v', 'c', 'c'];
  for (let i = 0; i < body.length; i++) {
    const { ch, pos: p } = body[i]!;
    const want = kinds[i % 5]!;
    const isV = VOWELS.includes(ch);
    const isC = CONSONANTS.includes(ch);
    const shown = showChar(text[p - 1]);
    if (!isV && !isC) throw new ToolError(T('error.letter', { char: shown, pos: p }));
    if ((want === 'v') !== isV) {
      throw new ToolError(
        T(want === 'v' ? 'error.wantVowel' : 'error.wantConsonant', { char: shown, pos: p }),
      );
    }
  }

  const out: number[] = [];
  const problems: BubbleProblem[] = [];
  let seed = 1;
  const groups = Math.ceil(body.length / 5);
  const flag = (g: number) => {
    const from = body[g * 5]!.pos;
    const to = body[Math.min(g * 5 + 4, body.length - 1)]!.pos;
    if (!lenient) throw new ToolError(T('error.checksum', { group: g + 1, from, to }));
    problems.push({ group: g + 1, from, to });
  };
  for (let g = 0; g < groups; g++) {
    const at = (k: number) => body[g * 5 + k]!;
    const v0 = VOWELS.indexOf(at(0).ch);
    const c1 = CONSONANTS.indexOf(at(1).ch);
    const v2 = VOWELS.indexOf(at(2).ch);
    const hi = (v0 - (seed % 6) + 6) % 6;
    const lo = (v2 - (Math.floor(seed / 6) % 6) + 6) % 6;
    if (g === groups - 1) {
      if (c1 === 16) {
        // The closing group of an even-length input carries only the seed.
        if (v0 !== seed % 6 || v2 !== Math.floor(seed / 6)) flag(g);
      } else {
        if (hi > 3 || lo > 3) flag(g);
        out.push(((hi & 3) << 6) | (c1 << 2) | (lo & 3));
      }
      break;
    }
    if (c1 === 16) {
      throw new ToolError(T('error.earlyX', { pos: at(1).pos }));
    }
    const c3 = CONSONANTS.indexOf(at(3).ch);
    const c4 = CONSONANTS.indexOf(at(4).ch);
    if (c3 === 16 || c4 === 16) {
      throw new ToolError(T('error.earlyX', { pos: at(c3 === 16 ? 3 : 4).pos }));
    }
    if (hi > 3 || lo > 3) flag(g);
    const b0 = ((hi & 3) << 6) | (c1 << 2) | (lo & 3);
    const b1 = (c3 << 4) | c4;
    out.push(b0, b1);
    seed = (seed * 5 + b0 * 7 + b1) % 36;
  }
  return { bytes: Uint8Array.from(out), problems };
}

const C = '[bcdfghklmnprstvz]';
const V = '[aeiouy]';
/** The exact shape of a Bubble Babble string (dashes optional, case ignored). */
export const BUBBLEBABBLE_SHAPE = new RegExp(
  `^x(?:${V}${C}${V}-?${C}-?${C}-?)*${V}[bcdfghklmnprstvzx]${V}x$`,
  'i',
);

export default defineTool({
  id: 'bubblebabble',
  name: 'Bubble Babble',
  category: 'encoding',
  description:
    'Encode or decode Bubble Babble, the pronounceable fingerprint of OpenSSH (xesef-disof-…), checksum verified.',
  tags: [
    'bubble babble',
    'bubblebabble',
    'ssh-keygen -B',
    'openssh',
    'fingerprint',
    'pronounceable',
  ],
  input: 'bytes',
  placeholder: 'xesef-disof-gytuf-katof-movif-baxux',
  live: true,
  options: {
    mode: toggle('Mode', ['decode', 'encode']),
    lenient: bool('Ignore checksum errors', false, {
      hint: 'Decode a damaged string anyway and list the groups whose checksum does not match.',
      showIf: (v) => v.mode === 'decode',
    }),
  },
  examples: [
    {
      label: 'Decode "1234567890" (spec example)',
      input: 'xesef-disof-gytuf-katof-movif-baxux',
      expect: '1234567890',
    },
    {
      label: 'Decode a flag',
      input: 'xinik-samak-luvak-dotuk-dumok-sanih-zamak-cymak-deruk-hazex',
      expect: 'flag{bubble_babble}',
    },
    {
      label: 'Encode "Pineapple"',
      input: 'Pineapple',
      options: { mode: 'encode' },
      expect: 'xigak-nyryk-humil-bosek-sonax',
    },
    {
      label: 'A damaged string, read anyway',
      input: 'xesef-disof-gytuf-katof-movif-baxax',
      options: { lenient: true },
      expect: 'Checksum does not match in group 6',
    },
  ],
  detect({ text }) {
    const t = text?.trim() ?? '';
    if (t.length < 5 || !BUBBLEBABBLE_SHAPE.test(t)) return null;
    try {
      const { bytes } = bubbleBabbleDecode(t);
      if (bytes.length < 2) return null;
      return { score: 0.92, options: { mode: 'decode' }, reason: T('detect.valid') };
    } catch {
      return {
        score: 0.5,
        options: { mode: 'decode', lenient: true },
        reason: T('detect.damaged'),
      };
    }
  },
  run({ bytes }, { mode, lenient }) {
    if (mode === 'encode') return [{ type: 'text', value: bubbleBabbleEncode(bytes) }];
    const { bytes: decoded, problems } = bubbleBabbleDecode(utf8Decode(bytes), lenient);
    const out: Output[] = bytesResult(decoded);
    for (const p of problems.slice(0, 5)) {
      out.push({
        type: 'note',
        level: 'warn',
        text: T('note.checksum', { group: p.group, from: p.from, to: p.to }),
      });
    }
    if (problems.length > 5) {
      out.push({
        type: 'note',
        level: 'warn',
        text: T('note.moreProblems', { count: problems.length - 5 }),
      });
    }
    return out;
  },
});
