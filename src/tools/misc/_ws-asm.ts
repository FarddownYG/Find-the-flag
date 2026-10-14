/**
 * Whitespace assembler (mnemonics -> S/T/L), disassembler (S/T/L -> readable listing) and
 * program generators (text -> program, program hidden in a cover text).
 */
import { ToolError } from '../../core/errors';
import { toolT } from '../../i18n/tool-text';
import {
  charLiteral,
  encodeNumber,
  OP_BY_NAME,
  OPS,
  type Instr,
  type OpDef,
  type Parsed,
} from './_ws-core';
import { labelText } from './_ws-vm';

const T = toolT('whitespace-lang');

/** Other spellings people use for the same instructions. */
const ALIASES: Record<string, string> = {
  duplicate: 'dup',
  dupe: 'dup',
  pick: 'copy',
  ref: 'copy',
  discard: 'drop',
  pop: 'drop',
  subtract: 'sub',
  multiply: 'mul',
  divide: 'div',
  modulo: 'mod',
  load: 'retrieve',
  fetch: 'retrieve',
  mark: 'label',
  jmp: 'jump',
  goto: 'jump',
  jumpz: 'jz',
  jzero: 'jz',
  jumpn: 'jn',
  jneg: 'jn',
  return: 'ret',
  exit: 'end',
  halt: 'end',
  outc: 'outchar',
  printc: 'outchar',
  putc: 'outchar',
  printchar: 'outchar',
  outn: 'outnum',
  printn: 'outnum',
  putn: 'outnum',
  printnum: 'outnum',
  readc: 'readchar',
  getc: 'readchar',
  readn: 'readnum',
  getn: 'readnum',
};

const MNEMONICS = OPS.map((o) => o.name).join(', ');

const ESC: Record<string, number> = { n: 10, t: 9, r: 13, '0': 0, '\\': 92, "'": 39, '"': 34 };

/** 'F', '\n', '\x41', '\u{1F600}' -> code point, or null if `s` is not a character literal. */
function parseCharLiteral(s: string): bigint | null {
  const m =
    /^'(?:\\(?:x([0-9a-fA-F]{2})|u\{([0-9a-fA-F]{1,6})\}|u([0-9a-fA-F]{4})|(.))|(.))'$/su.exec(s);
  if (!m) return null;
  const [, x, ub, u4, esc, plain] = m;
  if (x ?? ub ?? u4) return BigInt(parseInt((x ?? ub ?? u4)!, 16));
  if (esc !== undefined) {
    const code = ESC[esc];
    return code === undefined ? null : BigInt(code);
  }
  return BigInt(plain!.codePointAt(0)!);
}

function parseNumberArg(s: string): bigint | null {
  const ch = parseCharLiteral(s);
  if (ch !== null) return ch;
  const m = /^([+-]?)(0x[0-9a-f]+|0b[01]+|\d+)$/i.exec(s);
  if (!m) return null;
  const v = BigInt(m[2]!.toLowerCase());
  return m[1] === '-' ? -v : v;
}

type LabelRef = { literal: string } | { name: string };

/** "" -> empty, STTS -> literal letters, 12 -> binary (TTSS), anything else -> a symbolic name. */
function parseLabelArg(s: string): LabelRef | null {
  if (s === '""' || s === "''") return { literal: '' };
  if (/^[ST]+$/.test(s)) return { literal: s };
  if (/^\d+$/.test(s)) return { literal: binaryLetters(BigInt(s)) };
  if (/^[A-Za-z_.$][\w.$-]*$/.test(s)) return { name: s };
  return null;
}

const binaryLetters = (n: bigint) => n.toString(2).replace(/0/g, 'S').replace(/1/g, 'T');

/** Cut a line at the first ; # or // that is not inside a quoted character. */
function stripComment(line: string): string {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === ';' || c === '#' || (c === '/' && line[i + 1] === '/')) return line.slice(0, i);
  }
  return line;
}

interface Item {
  op: OpDef;
  num?: bigint;
  label?: LabelRef;
}

/**
 * Assemble mnemonic source into a program (S/T/L letters). One instruction per line; comments
 * start with ; # or //. `name:` marks a label. A disassembly listing (index, line and token
 * columns before the mnemonic) is accepted as is.
 */
export function assemble(src: string): string {
  const items: Item[] = [];
  src.split(/\r?\n/).forEach((rawLine, i) => {
    const lineNo = i + 1;
    // Disassembly columns: instruction index, source line, raw S/T/L tokens (maybe cut with …).
    let line = stripComment(rawLine)
      .trim()
      .replace(/^\d+\s+(?:\d+\s+)?(?:[STL]+(?:…[STL]*)?\s+)*/, '');
    const def = /^([^\s:]+):\s*(.*)$/.exec(line);
    if (def) {
      const ref = parseLabelArg(def[1]!);
      if (!ref) throw new ToolError(T('error.asmLabelName', { line: lineNo, name: def[1]! }));
      items.push({ op: OP_BY_NAME.get('label')!, label: ref });
      line = def[2]!.trim();
    }
    if (!line) return;
    const m = /^(\S+)\s*(.*)$/.exec(line)!;
    const word = m[1]!.toLowerCase();
    const arg = m[2]!.trim();
    const op = OP_BY_NAME.get(ALIASES[word] ?? word);
    if (!op) {
      throw new ToolError(T('error.asmUnknown', { line: lineNo, word: m[1]!, known: MNEMONICS }));
    }
    if (op.arg === 'none') {
      if (arg) throw new ToolError(T('error.asmNoArgument', { line: lineNo, op: op.name, arg }));
      items.push({ op });
    } else if (!arg) {
      throw new ToolError(
        op.arg === 'number'
          ? T('error.asmNeedsNumber', { line: lineNo, op: op.name })
          : T('error.asmNeedsLabel', { line: lineNo, op: op.name }),
      );
    } else if (op.arg === 'number') {
      const num = parseNumberArg(arg);
      if (num === null) {
        throw new ToolError(T('error.asmBadNumber', { line: lineNo, arg }));
      }
      items.push({ op, num });
    } else {
      const label = parseLabelArg(arg);
      if (!label) {
        throw new ToolError(T('error.asmBadLabel', { line: lineNo, arg }));
      }
      items.push({ op, label });
    }
  });
  if (!items.length) throw new ToolError(T('error.asmEmpty'));

  // Symbolic names get the shortest binary codes not already used by literal labels.
  const taken = new Set<string>();
  for (const it of items) if (it.label && 'literal' in it.label) taken.add(it.label.literal);
  const assigned = new Map<string, string>();
  let next = 1n;
  const resolve = (ref: LabelRef): string => {
    if ('literal' in ref) return ref.literal;
    let code = assigned.get(ref.name);
    if (code === undefined) {
      do code = binaryLetters(next++);
      while (taken.has(code));
      taken.add(code);
      assigned.set(ref.name, code);
    }
    return code;
  };
  return items
    .map((it) => {
      if (it.num !== undefined) return it.op.code + encodeNumber(it.num);
      if (it.label) return `${it.op.code}${resolve(it.label)}L`;
      return it.op.code;
    })
    .join('');
}

/** 1-based line of each token when the program itself is the text (count the line feeds). */
export function linesOfCode(code: string): Int32Array {
  const lines = new Int32Array(code.length);
  let line = 1;
  for (let i = 0; i < code.length; i++) {
    lines[i] = line;
    if (code[i] === 'L') line++;
  }
  return lines;
}

const TOKEN_COLUMN = 26;

/** "SS STSSSTTSL"; a long argument is cut in the middle so that the columns stay aligned. */
function tokenText(ins: Instr): string {
  const { code } = ins.op;
  if (ins.raw.length === code.length) return code;
  const arg = ins.raw.slice(code.length);
  const room = TOKEN_COLUMN - code.length - 2;
  if (arg.length <= room) return `${code} ${arg}`;
  const tail = Math.floor(room / 2);
  return `${code} ${arg.slice(0, room - tail)}…${arg.slice(-tail)}`;
}

/**
 * The character a push stands for, as a comment. Printable ASCII always; line feeds, other
 * controls and non-ASCII characters only when the value goes straight to outchar or store, so that
 * loop counters, addresses and numbers do not get a misleading character.
 */
function pushNote(n: bigint, next: Instr | undefined): string {
  const lit = charLiteral(n);
  if (!lit) return '';
  if (n >= 0x20n && n < 0x7fn) return lit;
  return next?.op.name === 'outchar' || next?.op.name === 'store' ? lit : '';
}

/**
 * Readable listing, one instruction per line: index, source line, raw tokens, mnemonic and
 * argument, then a comment (character of a push, label number L1, L2...). The listing is valid
 * assembler input, so it can be edited and re-assembled.
 */
export function disassemble(parsed: Parsed, lines?: ArrayLike<number>, maxRows = 5000): string {
  const { instrs, tail } = parsed;
  const lineOf = lines ?? linesOfCode(parsed.code);
  const ids = new Map<string, number>();
  for (const ins of instrs) {
    if (ins.op.name === 'label' && !ids.has(ins.label!)) ids.set(ins.label!, ids.size + 1);
  }
  const shown = instrs.slice(0, maxRows);
  const iw = String(instrs.length).length;
  const lw = Math.max(4, String(lineOf[parsed.code.length - 1] ?? 1).length);
  const tokens = shown.map(tokenText);
  const tw = Math.max(6, ...tokens.map((t) => t.length));
  const seen = new Set<string>();
  const rows = shown.map((ins, i) => {
    let text = ins.op.name;
    let note = '';
    if (ins.num !== undefined) {
      text += ` ${ins.num}`;
      if (ins.op.name === 'push') note = pushNote(ins.num, instrs[i + 1]);
    } else if (ins.label !== undefined) {
      text += ` ${labelText(ins.label)}`;
      const id = ids.get(ins.label);
      if (ins.op.name === 'label') {
        note = seen.has(ins.label) ? T('text.labelAgain', { id: `L${id}` }) : `L${id}`;
        seen.add(ins.label);
      } else note = id ? `L${id}` : T('text.neverMarked');
    }
    const line = lineOf[ins.start] ?? 1;
    const head = `${String(i).padStart(iw)}  ${String(line).padStart(lw)}  ${tokens[i]!.padEnd(tw)}  `;
    return note ? `${head}${text.padEnd(14)}  ; ${note}` : `${head}${text}`;
  });
  const out = [
    `${'#'.padStart(iw)}  ${T('text.columnLine').padStart(lw)}  ${T('text.columnTokens').padEnd(tw)}  ${T('text.columnInstruction')}`,
    ...rows,
  ];
  if (instrs.length > shown.length) {
    const more = instrs.length - shown.length;
    out.push(`; … ${T('text.moreInstructions', { count: more })}`);
  }
  if (tail) {
    const line = lineOf[tail.start] ?? 1;
    const raw = tail.raw.length > 24 ? `${tail.raw.slice(0, 24)}…` : tail.raw;
    out.push(
      `; ${T('text.parsingStops', { index: instrs.length, line, tokens: raw, reason: tail.reason })}`,
    );
  }
  return out.join('\n');
}

/** A program printing `text` exactly: push + outchar per character, then end. */
export function textToProgram(text: string): { code: string; listing: string } {
  const code: string[] = [];
  const listing: string[] = [];
  for (const ch of text) {
    const cp = BigInt(ch.codePointAt(0)!);
    code.push(`SS${encodeNumber(cp)}`, 'TLSS');
    const lit = charLiteral(cp);
    listing.push(lit ? `push ${cp}  ; ${lit}` : `push ${cp}`, 'outchar');
  }
  code.push('LLL');
  listing.push('end');
  return { code: code.join(''), listing: listing.join('\n') };
}

export interface Hidden {
  text: string;
  /** Cover lines whose end (trailing whitespace + line feed) carries the program. */
  linesUsed: number;
  /** Empty lines appended because the cover was too short. */
  linesAdded: number;
  /** Cover lines whose own trailing spaces/tabs were removed first. */
  linesCleaned: number;
}

/**
 * Hide a program in the trailing whitespace of a cover text: the program is cut at each L; the
 * k-th piece goes at the end of line k and the line break plays the L. Read it back with the
 * 'trailing' extraction (every line feed counts).
 */
export function hideInCover(code: string, cover: string): Hidden {
  const rows = cover.split(/\r?\n/);
  if (rows.length > 1 && rows[rows.length - 1] === '') rows.pop();
  let linesCleaned = 0;
  const clean = rows.map((r) => {
    const t = r.replace(/[ \t]+$/, '');
    if (t !== r) linesCleaned++;
    return t;
  });
  const pieces = code.split('L');
  // One line per line feed of the program, plus one for what follows the last line feed.
  const need = pieces.length - 1 + (pieces[pieces.length - 1] ? 1 : 0);
  const out: string[] = [];
  for (let i = 0; i < Math.max(pieces.length, clean.length); i++) {
    const ws = (pieces[i] ?? '').replace(/S/g, ' ').replace(/T/g, '\t');
    out.push((clean[i] ?? '') + ws);
  }
  return {
    text: out.join('\n'),
    linesUsed: Math.min(need, clean.length),
    linesAdded: Math.max(0, need - clean.length),
    linesCleaned,
  };
}
