/**
 * The Enigma machine: Enigma I (Wehrmacht / Luftwaffe), M3 and M4 (Kriegsmarine).
 *
 * Wirings and turnover (notch) letters are the historical ones, as published by Crypto Museum and
 * the Bletchley Park papers. A key press goes: plugboard -> right, middle, left (and Greek) rotor
 * -> reflector -> back through the rotors -> plugboard. The rotors step BEFORE the current flows,
 * and the middle rotor "double steps": when it sits on its own notch it carries the left rotor
 * along with it, one press after the right rotor moved it there.
 *
 * Everything here is pure; the tool in enigma.ts wraps it, _enigma-search.ts adds the crib tools.
 */
import { ToolError } from '../../core/errors';
import { toolT } from '../../i18n/tool-text';

const T = toolT('enigma');

export type MachineId = 'enigma1' | 'm3' | 'm4';
export type ReflectorId = 'A' | 'B' | 'C' | 'B-thin' | 'C-thin';

export interface MachineInfo {
  /** Rotors in the machine, the Greek wheel included. */
  wheels: 3 | 4;
  /** Rotors that machine could hold (the Greek wheels of the M4 are separate). */
  rotors: readonly string[];
  reflectors: readonly ReflectorId[];
}

export const ROTOR_NAMES = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'] as const;
export const GREEK_NAMES = ['Beta', 'Gamma'] as const;

export const MACHINES: Record<MachineId, MachineInfo> = {
  // Wehrmacht and Luftwaffe: five rotors to choose three from.
  enigma1: { wheels: 3, rotors: ROTOR_NAMES.slice(0, 5), reflectors: ['A', 'B', 'C'] },
  // Kriegsmarine with three rotors: eight rotors, VI to VIII with two notches.
  m3: { wheels: 3, rotors: ROTOR_NAMES, reflectors: ['B', 'C'] },
  // Kriegsmarine with four rotors (from 1942): a thin reflector and a Greek wheel that never turns.
  m4: { wheels: 4, rotors: ROTOR_NAMES, reflectors: ['B-thin', 'C-thin'] },
};

/** Wiring (what the contact of each letter A..Z is connected to) and the turnover letters. */
const ROTOR_DATA: Record<string, { wiring: string; notches: string }> = {
  I: { wiring: 'EKMFLGDQVZNTOWYHXUSPAIBRCJ', notches: 'Q' },
  II: { wiring: 'AJDKSIRUXBLHWTMCQGZNPYFVOE', notches: 'E' },
  III: { wiring: 'BDFHJLCPRTXVZNYEIWGAKMUSQO', notches: 'V' },
  IV: { wiring: 'ESOVPZJAYQUIRHXLNFTGKDCMWB', notches: 'J' },
  V: { wiring: 'VZBRGITYUPSDNHLXAWMJQOFECK', notches: 'Z' },
  VI: { wiring: 'JPGVOUMFYQBENHZRDKASXLICTW', notches: 'ZM' },
  VII: { wiring: 'NZJHGRCXMYSWBOUFAIVLPEKQDT', notches: 'ZM' },
  VIII: { wiring: 'FKQHTLXOCBJSPDZRAMEWNIUYGV', notches: 'ZM' },
  Beta: { wiring: 'LEYJVCNIXWPBQMDRTAKZGFUHOS', notches: '' },
  Gamma: { wiring: 'FSOKANUERHMBTIYCWLQPZXVGJD', notches: '' },
};

const REFLECTOR_DATA: Record<ReflectorId, string> = {
  A: 'EJMZALYXVBWFCRQUONTSPIKHGD',
  B: 'YRUHQSLDPXNGOKMIEBFZCWVJAT',
  C: 'FVPJIAOYEDRZXWGCTKUQSBNMHL',
  'B-thin': 'ENKQAUYWJICOPBLMDXZVFTHRGS',
  'C-thin': 'RDOBJNTKVEHMLFCWZAXGYIPSUQ',
};

export const REFLECTOR_IDS = Object.keys(REFLECTOR_DATA) as ReflectorId[];

export const rotorWiring = (name: string): string => ROTOR_DATA[name]?.wiring ?? '';
/** Turnover letters of a rotor as shown in its window ("Q", "ZM", "" for the Greek wheels). */
export const rotorNotches = (name: string): string => ROTOR_DATA[name]?.notches ?? '';
export const reflectorWiring = (id: ReflectorId): string => REFLECTOR_DATA[id];
export const reflectorName = (id: ReflectorId): string => `UKW-${id}`;

export const letterOf = (v: number): string => String.fromCharCode(65 + v);
export const lettersString = (values: ArrayLike<number>, sep = ''): string =>
  Array.from(values, letterOf).join(sep);

// ---------- tables ----------

const code = (ch: string): number => ch.charCodeAt(0) - 65;

interface RotorTables {
  /** fwd[offset * 26 + contact]: right-to-left path through the rotor at that offset. */
  fwd: Uint8Array;
  /** The same for the way back, left to right. */
  bwd: Uint8Array;
  /** notch[window letter] = 1 where the rotor lets the next one step. */
  notch: Uint8Array;
}

const tableCache = new Map<string, RotorTables>();

/** Rotor tables: the wiring shifted by the offset (position - ring), once for every offset. */
export function rotorTables(name: string): RotorTables {
  const cached = tableCache.get(name);
  if (cached) return cached;
  const data = ROTOR_DATA[name];
  if (!data) throw new Error(`Unknown rotor ${name}`);
  const wire = [...data.wiring].map(code);
  const inv = new Array<number>(26);
  wire.forEach((v, i) => (inv[v] = i));
  const fwd = new Uint8Array(26 * 26);
  const bwd = new Uint8Array(26 * 26);
  for (let off = 0; off < 26; off++) {
    for (let c = 0; c < 26; c++) {
      fwd[off * 26 + c] = (wire[(c + off) % 26]! + 26 - off) % 26;
      bwd[off * 26 + c] = (inv[(c + off) % 26]! + 26 - off) % 26;
    }
  }
  const notch = new Uint8Array(26);
  for (const ch of data.notches) notch[code(ch)] = 1;
  const tables = { fwd, bwd, notch };
  tableCache.set(name, tables);
  return tables;
}

export function reflectorTable(id: ReflectorId): Uint8Array {
  return Uint8Array.from([...REFLECTOR_DATA[id]].map(code));
}

export function plugTable(plugs: readonly (readonly [number, number])[]): Uint8Array {
  const table = Uint8Array.from({ length: 26 }, (_, i) => i);
  for (const [a, b] of plugs) {
    table[a] = b;
    table[b] = a;
  }
  return table;
}

// ---------- the machine ----------

export interface EnigmaSetup {
  machine: MachineId;
  /** Rotor names, left to right; the M4 starts with its Greek wheel. */
  rotors: readonly string[];
  reflector: ReflectorId;
  /** Ring settings (Ringstellung), 0..25 per rotor, same order. */
  rings: readonly number[];
  /** Start positions (Grundstellung), 0..25 per rotor, same order. */
  start: readonly number[];
  plugs: readonly (readonly [number, number])[];
}

/** Everything that happens on one key press, for the step table. */
export interface PressTrace {
  /** Rotor window letters before the key is pressed (left to right). */
  before: number[];
  /** ... and when the current flows (after the rotors stepped). */
  after: number[];
  /** Which wheels moved on this press. */
  moved: boolean[];
  /** The middle rotor moved because it stood on its own notch (the double step). */
  doubleStep: boolean;
  input: number;
  /** After the plugboard. */
  plugIn: number;
  /** Letter after each rotor on the way in, from the rightmost to the leftmost. */
  forward: number[];
  reflected: number;
  /** Letter after each rotor on the way back, from the leftmost to the rightmost. */
  backward: number[];
  plugOut: number;
  output: number;
}

export class Enigma {
  readonly wheels: number;
  /** Window letters 0..25, left to right. Changes as keys are pressed. */
  readonly pos: Uint8Array;
  private readonly tables: RotorTables[];
  private readonly ring: Uint8Array;
  private readonly refl: Uint8Array;
  private readonly plug: Uint8Array;

  constructor(setup: EnigmaSetup) {
    this.wheels = setup.rotors.length;
    this.tables = setup.rotors.map(rotorTables);
    this.ring = Uint8Array.from(setup.rings);
    this.pos = Uint8Array.from(setup.start);
    this.refl = reflectorTable(setup.reflector);
    this.plug = plugTable(setup.plugs);
  }

  /** The right rotor always steps; the middle one on the right notch or its own; then the left one. */
  private step(): { mask: number; doubleStep: boolean } {
    const p = this.pos;
    const r = this.wheels - 1;
    const m = r - 1;
    const l = m - 1;
    let mask = 1 << r;
    let doubleStep = false;
    if (this.tables[m]!.notch[p[m]!] === 1) {
      p[l] = (p[l]! + 1) % 26;
      p[m] = (p[m]! + 1) % 26;
      mask |= (1 << l) | (1 << m);
      doubleStep = this.tables[r]!.notch[p[r]!] !== 1;
    } else if (this.tables[r]!.notch[p[r]!] === 1) {
      p[m] = (p[m]! + 1) % 26;
      mask |= 1 << m;
    }
    p[r] = (p[r]! + 1) % 26;
    return { mask, doubleStep };
  }

  /** Press one key (0..25): the rotors step, then the current flows. Returns the lamp. */
  press(letter: number): number {
    this.step();
    const n = this.wheels;
    const p = this.pos;
    let c = this.plug[letter]!;
    for (let i = n - 1; i >= 0; i--) {
      c = this.tables[i]!.fwd[((p[i]! + 26 - this.ring[i]!) % 26) * 26 + c]!;
    }
    c = this.refl[c]!;
    for (let i = 0; i < n; i++) {
      c = this.tables[i]!.bwd[((p[i]! + 26 - this.ring[i]!) % 26) * 26 + c]!;
    }
    return this.plug[c]!;
  }

  /** Like press(), but keeps every intermediate letter (slower: for the step table only). */
  trace(letter: number): PressTrace {
    const n = this.wheels;
    const before = Array.from(this.pos);
    const { mask, doubleStep } = this.step();
    const after = Array.from(this.pos);
    const moved = Array.from({ length: n }, (_, i) => (mask & (1 << i)) !== 0);
    const plugIn = this.plug[letter]!;
    let c = plugIn;
    const forward: number[] = [];
    for (let i = n - 1; i >= 0; i--) {
      c = this.tables[i]!.fwd[((after[i]! + 26 - this.ring[i]!) % 26) * 26 + c]!;
      forward.push(c);
    }
    const reflected = this.refl[c]!;
    c = reflected;
    const backward: number[] = [];
    for (let i = 0; i < n; i++) {
      c = this.tables[i]!.bwd[((after[i]! + 26 - this.ring[i]!) % 26) * 26 + c]!;
      backward.push(c);
    }
    const output = this.plug[c]!;
    return {
      before,
      after,
      moved,
      doubleStep,
      input: letter,
      plugIn,
      forward,
      reflected,
      backward,
      plugOut: c,
      output,
    };
  }
}

// ---------- text ----------

export interface TransformOptions {
  /** Keep the characters that are not A-Z where they are (otherwise drop them). */
  keep: boolean;
  /** Letters only, in blocks of five. */
  group: boolean;
}

export interface TransformResult {
  text: string;
  /** Letters A-Z run through the machine. */
  letters: number;
  /** Anything else that was kept or dropped, spaces and line breaks apart. */
  others: number;
  /** Letters outside A-Z (accents, umlauts, ß, Cyrillic...) among those others. */
  foreign: number;
}

export function transformText(
  machine: Enigma,
  input: string,
  { keep, group }: TransformOptions,
): TransformResult {
  const out: string[] = [];
  let letters = 0;
  let others = 0;
  let foreign = 0;
  for (const ch of input) {
    const c = ch.charCodeAt(0);
    const upper = c >= 65 && c <= 90;
    const lower = c >= 97 && c <= 122;
    if (upper || lower) {
      const v = machine.press(c - (upper ? 65 : 97));
      // Keeping the other characters keeps the case too; as a plain letter stream it is capitals.
      out.push(String.fromCharCode(v + (lower && keep && !group ? 97 : 65)));
      letters++;
    } else {
      if (!/\s/u.test(ch)) {
        others++;
        if (/\p{L}/u.test(ch)) foreign++;
      }
      if (keep && !group) out.push(ch);
    }
  }
  if (!group) return { text: out.join(''), letters, others, foreign };
  const blocks: string[] = [];
  for (let i = 0; i < out.length; i += 5) blocks.push(out.slice(i, i + 5).join(''));
  return { text: blocks.join(' '), letters, others, foreign };
}

// ---------- reading the settings ----------

const SEPARATORS = /[\s,;/.\-_|]+/u;

const ROTOR_ALIASES: Record<string, string> = {
  I: 'I',
  II: 'II',
  III: 'III',
  IV: 'IV',
  V: 'V',
  VI: 'VI',
  VII: 'VII',
  VIII: 'VIII',
  '1': 'I',
  '2': 'II',
  '3': 'III',
  '4': 'IV',
  '5': 'V',
  '6': 'VI',
  '7': 'VII',
  '8': 'VIII',
  BETA: 'Beta',
  '\u0392': 'Beta', // Greek capital beta (what upper-casing the letter gives)
  GAMMA: 'Gamma',
  '\u0393': 'Gamma',
};

/** One rotor name as written ("IV", "4", "beta") -> its canonical name. */
function rotorName(token: string, machine: MachineId): string {
  const name = ROTOR_ALIASES[token.toUpperCase()];
  if (!name) {
    throw new ToolError(T('error.rotorUnknown', { token, machine: machineName(machine) }));
  }
  return name;
}

/** "II IV V", "2-4-5", "Beta II IV I" -> rotor names, checked against the machine. */
export function parseRotors(text: string, machine: MachineId): string[] {
  const info = MACHINES[machine];
  const names = text
    .split(SEPARATORS)
    .filter(Boolean)
    .map((token) => rotorName(token, machine));
  if (names.length !== info.wheels) {
    throw new ToolError(
      T('error.rotorCount', {
        machine: machineName(machine),
        count: info.wheels,
        example: machine === 'm4' ? 'Beta II IV I' : 'I II III',
        got: names.length,
      }),
    );
  }
  names.forEach((name, i) => {
    const greek = (GREEK_NAMES as readonly string[]).includes(name);
    if (machine === 'm4') {
      if (i === 0 && !greek) throw new ToolError(T('error.greekFirst', { rotor: name }));
      if (i > 0 && greek) throw new ToolError(T('error.greekPlace', { rotor: name }));
    } else if (greek) {
      throw new ToolError(T('error.greekMachine', { rotor: name, machine: machineName(machine) }));
    }
    if (!greek && !info.rotors.includes(name)) {
      throw new ToolError(T('error.rotorMachine', { rotor: name, machine: machineName(machine) }));
    }
  });
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) throw new ToolError(T('error.rotorTwice', { rotor: name }));
    seen.add(name);
  }
  return names;
}

/**
 * The rotors a crib search may use for its three turning wheels: the ones listed, or every rotor
 * the machine had when the text is empty.
 */
export function parseRotorPool(text: string, machine: MachineId): string[] {
  const info = MACHINES[machine];
  const tokens = text.split(SEPARATORS).filter(Boolean);
  if (!tokens.length) return [...info.rotors];
  const pool: string[] = [];
  for (const token of tokens) {
    const name = rotorName(token, machine);
    if ((GREEK_NAMES as readonly string[]).includes(name)) {
      throw new ToolError(T('error.greekMachine', { rotor: name, machine: machineName(machine) }));
    }
    if (!info.rotors.includes(name)) {
      throw new ToolError(T('error.rotorMachine', { rotor: name, machine: machineName(machine) }));
    }
    if (!pool.includes(name)) pool.push(name);
  }
  if (pool.length < 3) throw new ToolError(T('error.poolSmall'));
  return pool;
}

/** "BUL", "B U L", "2 21 12" -> 0..25 each. A letter or a number 1..26 per rotor. */
export function parsePositions(text: string, count: number, label: string): number[] {
  const trimmed = text.trim();
  const tokens = trimmed.split(SEPARATORS).filter(Boolean);
  const wholeWord =
    tokens.length === 1 && /^[A-Za-z]+$/.test(tokens[0]!) && tokens[0]!.length > 1
      ? [...tokens[0]!]
      : tokens;
  const values = wholeWord.map((tok) => {
    if (/^[A-Za-z]$/.test(tok)) return tok.toUpperCase().charCodeAt(0) - 65;
    if (/^\d{1,2}$/.test(tok) && +tok >= 1 && +tok <= 26) return +tok - 1;
    throw new ToolError(T('error.positionValue', { label, token: tok }));
  });
  if (values.length !== count) {
    throw new ToolError(
      T('error.positionCount', {
        label,
        count,
        example: count === 4 ? 'A A A V' : 'B U L',
        got: values.length,
      }),
    );
  }
  return values;
}

/** "AV BS CG" -> pairs of 0..25; checks the letters are different and each used once. */
export function parsePlugboard(text: string): [number, number][] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  let tokens = trimmed.split(/[\s,;/]+/u).filter(Boolean);
  // "AVBSCG" with no separator at all: read it as pairs.
  if (tokens.length === 1 && tokens[0]!.length > 2 && /^[A-Za-z]+$/.test(tokens[0]!)) {
    tokens = tokens[0]!.match(/.{1,2}/g) ?? [];
  }
  const pairs: [number, number][] = [];
  const owner = new Map<number, string>();
  for (const raw of tokens) {
    const tok = raw.replace(/[-=:<>\u2194]/gu, '');
    if (!/^[A-Za-z]{2}$/.test(tok)) throw new ToolError(T('error.plugPair', { pair: raw }));
    const a = tok.toUpperCase().charCodeAt(0) - 65;
    const b = tok.toUpperCase().charCodeAt(1) - 65;
    if (a === b) throw new ToolError(T('error.plugSelf', { letter: letterOf(a) }));
    for (const v of [a, b]) {
      const other = owner.get(v);
      if (other !== undefined) {
        throw new ToolError(
          T('error.plugTwice', { letter: letterOf(v), first: other, second: tok.toUpperCase() }),
        );
      }
      owner.set(v, tok.toUpperCase());
    }
    pairs.push([a, b]);
  }
  return pairs;
}

export const machineName = (machine: MachineId): string =>
  ({ enigma1: 'Enigma I', m3: 'M3', m4: 'M4' })[machine];

export function checkReflector(machine: MachineId, reflector: ReflectorId): void {
  if (!MACHINES[machine].reflectors.includes(reflector)) {
    throw new ToolError(
      T('error.reflector', {
        reflector: reflectorName(reflector),
        machine: machineName(machine),
        allowed: MACHINES[machine].reflectors.map(reflectorName).join(', '),
      }),
    );
  }
}

export interface SetupText {
  machine: MachineId;
  rotors: string;
  reflector: ReflectorId;
  rings: string;
  start: string;
  plugboard: string;
}

/** Build the machine settings from what the user typed (every problem is a ToolError). */
export function readSetup(o: SetupText): EnigmaSetup {
  checkReflector(o.machine, o.reflector);
  const rotors = parseRotors(o.rotors, o.machine);
  return {
    machine: o.machine,
    rotors,
    reflector: o.reflector,
    rings: parsePositions(o.rings, rotors.length, T('label.rings')),
    start: parsePositions(o.start, rotors.length, T('label.start')),
    plugs: parsePlugboard(o.plugboard),
  };
}

/** Encrypt or decrypt a string of letters 0..25 from the given start (a fresh machine each time). */
export function runLetters(setup: EnigmaSetup, letters: readonly number[]): number[] {
  const machine = new Enigma(setup);
  return letters.map((v) => machine.press(v));
}

/** Letters A-Z (any case) of a text as values 0..25. */
export function letterValues(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i) | 0x20;
    if (c >= 97 && c <= 122) out.push(c - 97);
  }
  return out;
}
