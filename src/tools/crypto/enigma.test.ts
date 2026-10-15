import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { defaultOptions, getTool } from '../../core/registry';
import { resultToText } from '../../core/result-text';
import type { Output, ToolResult } from '../../core/types';
import { makeRng } from './_classical';
import {
  Enigma,
  GREEK_NAMES,
  MACHINES,
  REFLECTOR_IDS,
  ROTOR_NAMES,
  letterValues,
  lettersString,
  parsePlugboard,
  parsePositions,
  parseRotorPool,
  parseRotors,
  readSetup,
  reflectorWiring,
  rotorNotches,
  rotorWiring,
  runLetters,
  transformText,
  type EnigmaSetup,
  type MachineId,
  type SetupText,
} from './_enigma';
import {
  cribPlacements,
  decryptWithHit,
  searchCrib,
  stepBack,
  type CribSearchInput,
} from './_enigma-search';
import {
  SAMPLE_M3,
  SAMPLE_M4,
  SAMPLE_PLUG,
  buildSamples,
  encryptLetters,
  formatGroups,
} from './_enigma-samples';
import tool from './enigma';

const base: SetupText = {
  machine: 'enigma1',
  rotors: 'I II III',
  reflector: 'B',
  rings: 'A A A',
  start: 'A A A',
  plugboard: '',
};

/** Run a message of letters through the machine described by `over` (Enigma I I-II-III UKW-B AAA). */
const enc = (letters: string, over: Partial<SetupText> = {}): string =>
  lettersString(runLetters(readSetup({ ...base, ...over }), letterValues(letters)));

const registered = getTool('enigma')!;
const run = (input: string, options: Record<string, unknown> = {}): Output[] =>
  tool.run(input, { ...defaultOptions(registered), ...options } as never) as ToolResult;
const text = (input: string, options: Record<string, unknown> = {}): string =>
  resultToText(run(input, options));

// ---------------------------------------------------------------------------------------------
// Published vectors
// ---------------------------------------------------------------------------------------------

describe('published test vectors', () => {
  it('Enigma I, rotors I-II-III, UKW-B, rings AAA, start AAA: AAAAA -> BDZGO', () => {
    // The classic first test of every Enigma simulator (Crypto Museum, Wikipedia, Cryptii, ...).
    expect(enc('AAAAA')).toBe('BDZGO');
  });

  it('the same settings give BDZGOWCXLTKSBTMCDLPBMUQOFX for 26 A, which crosses the right notch', () => {
    // Right rotor III turns the middle one at V (the 22nd key): the vector goes through a step.
    expect(enc('A'.repeat(26))).toBe('BDZGOWCXLTKSBTMCDLPBMUQOFX');
  });

  it('HELLOWORLD -> ILBDAAMTAZ with the same settings', () => {
    expect(enc('HELLOWORLD')).toBe('ILBDAAMTAZ');
  });

  it('double stepping: rotors I-II-III from ADU read ADV, AEW, BFX after three key presses', () => {
    // The well-known anomaly: the middle rotor (II, notch E) steps on the press after the right
    // rotor (III, notch V) pushed it, and on that press it takes the left rotor along.
    const machine = new Enigma(readSetup({ ...base, start: 'A D U' }));
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      machine.press(0);
      seen.push(lettersString(machine.pos));
    }
    expect(seen).toEqual(['ADV', 'AEW', 'BFX']);
  });

  // Operation Barbarossa message (June 1941), Enigma I: Walzenlage II IV V, Ringstellung B U L
  // (02 21 12), Grundstellung B L A, Steckerverbindungen AV BS CG DL FU HZ IN KM OW RX. This is
  // the sample published by Crypto Museum and reproduced in the Enigma literature.
  const BARBAROSSA_SETTINGS: Partial<SetupText> = {
    rotors: 'II IV V',
    rings: 'B U L',
    start: 'B L A',
    plugboard: 'AV BS CG DL FU HZ IN KM OW RX',
  };
  const BARBAROSSA_CIPHER =
    'EDPUD NRGYS ZRCXN UYTPO MRMBO FKTBZ REZKM LXLVE FGUEY SIOZV EQMIK UBPMM YLKLT TDEIS ' +
    'MDICA GYKUA CTCDO MOHWX MUUIA UBSTS LRNBZ SZWNR FXWFY SSXJZ VIJHI DISHP RKLKA YUPAD ' +
    'TXQSP INQMA TLPIF SVKDA SCTAC DPBOP VHJK';
  const BARBAROSSA_PLAIN =
    'AUFKL XABTE ILUNG XVONX KURTI NOWAX KURTI NOWAX NORDW ESTLX SEBEZ XSEBE ZXUAF FLIEG ' +
    'ERSTR ASZER IQTUN GXDUB ROWKI XDUBR OWKIX OPOTS CHKAX OPOTS CHKAX UMXEI NSAQT DREIN ' +
    'ULLXU HRANG ETRET ENXAN GRIFF XINFX RGTX';

  it('decrypts the Operation Barbarossa message (rings, three rotors, ten plugs, double steps)', () => {
    const got = enc(BARBAROSSA_CIPHER, BARBAROSSA_SETTINGS);
    expect(got).toBe(BARBAROSSA_PLAIN.replace(/ /g, ''));
  });

  // M4 message sent by U-264 in November 1942, one of the messages broken by the
  // M4 Message Breaking Project: UKW B-thin, Walzenlage Beta II IV I, Ringstellung A A A V
  // (01 01 01 22), Grundstellung V J N A, Steckerverbindungen AT BL DF GJ HM NW OP QY RZ VX.
  const M4_SETTINGS: Partial<SetupText> = {
    machine: 'm4',
    rotors: 'Beta II IV I',
    reflector: 'B-thin',
    rings: 'A A A V',
    start: 'V J N A',
    plugboard: 'AT BL DF GJ HM NW OP QY RZ VX',
  };
  const M4_CIPHER =
    'NCZW VUSX PNYM INHZ XMQX SFWX WLKJ AHSH NMCO CCAK UQPM KCSM HKSE INJU SBLK IOSX CKUB ' +
    'HMLL XCSJ USRR DVKO HULX WCCB GVLI YXEO AHXR HKKF VDRE WEZL XOBA FGYU JQUK GRTV UKAM ' +
    'EURB VEKS UHHV OYHA BCJW MAKL FKLM YFVN RIZR VVRT KOFD ANJM OLBG FFLE OPRG TFLV RHOW ' +
    'OPBE KVWM UQFM PWPA RMFH AGKX IIBG';
  const M4_PLAIN =
    'VONVONJLOOKSJHFFTTTEINSEINSDREIZWOYYQNNSNEUNINHALTXXBEIANGRIFFUNTERWASSERGEDRUECKTYWABOS' +
    'XLETZTERGEGNERSTANDNULACHTDREINULUHRMARQUANTONJOTANEUNACHTSEYHSDREIYZWOZWONULGRADYACHTSMY' +
    'STOSSENACHXEKNSVIERMBFAELLTYNNNNNNOOOVIERYSICHTEINSNULL';

  it('decrypts the U-264 M4 message (thin reflector, Greek wheel, ring on the right rotor)', () => {
    expect(enc(M4_CIPHER, M4_SETTINGS)).toBe(M4_PLAIN);
  });
});

// ---------------------------------------------------------------------------------------------
// The machine's data and behaviour
// ---------------------------------------------------------------------------------------------

describe('rotors and reflectors', () => {
  it('every rotor is a permutation and the reflectors are fixed-point-free involutions', () => {
    for (const name of [...ROTOR_NAMES, ...GREEK_NAMES]) {
      expect([...rotorWiring(name)].sort().join('')).toBe('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    }
    for (const id of REFLECTOR_IDS) {
      const w = reflectorWiring(id);
      expect([...w].sort().join('')).toBe('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
      for (let i = 0; i < 26; i++) {
        const j = w.charCodeAt(i) - 65;
        expect(j).not.toBe(i);
        expect(w.charCodeAt(j) - 65).toBe(i);
      }
    }
  });

  it('has the historical notches: Q E V J Z, and Z + M on VI, VII and VIII', () => {
    expect(ROTOR_NAMES.map(rotorNotches)).toEqual(['Q', 'E', 'V', 'J', 'Z', 'ZM', 'ZM', 'ZM']);
    expect(GREEK_NAMES.map(rotorNotches)).toEqual(['', '']);
  });

  it('an M4 with Beta (or Gamma) at A, ring A and a thin B (or C) reflector is an M3 with UKW-B (or C)', () => {
    // The thin reflector plus the Greek wheel at A is the same permutation as the thick reflector:
    // this is how the M4 stayed compatible with the M3 networks.
    const message =
      'THEQUICKBROWNFOXJUMPSOVERTHELAZYDOGANDKEEPSRUNNINGUNTILTHEROTORSTURNOVER'.repeat(3);
    for (const [greek, thin, thick] of [
      ['Beta', 'B-thin', 'B'],
      ['Gamma', 'C-thin', 'C'],
    ] as const) {
      const m3 = enc(message, {
        machine: 'm3',
        rotors: 'VI III VIII',
        reflector: thick,
        rings: 'F B C',
        start: 'Q E V',
      });
      const m4 = enc(message, {
        machine: 'm4',
        rotors: `${greek} VI III VIII`,
        reflector: thin,
        rings: 'A F B C',
        start: 'A Q E V',
      });
      expect(m4).toBe(m3);
    }
  });
});

describe('stepping', () => {
  const positionsAfter = (rotors: string, start: string, presses: number): string[] => {
    const machine = new Enigma(readSetup({ ...base, machine: 'm3', rotors, start }));
    const out: string[] = [];
    for (let i = 0; i < presses; i++) {
      machine.press(0);
      out.push(lettersString(machine.pos));
    }
    return out;
  };

  it('turns the middle rotor when the right rotor passes its notch (one notch for I-V)', () => {
    // III has its notch at V: the press that moves V to W also moves the middle rotor.
    expect(positionsAfter('I II III', 'A A U', 3)).toEqual(['AAV', 'ABW', 'ABX']);
    // I: Q -> R. IV: J -> K. V: Z -> A.
    expect(positionsAfter('II III I', 'A A P', 2)).toEqual(['AAQ', 'ABR']);
    expect(positionsAfter('I II IV', 'A A I', 2)).toEqual(['AAJ', 'ABK']);
    expect(positionsAfter('I II V', 'A A Y', 2)).toEqual(['AAZ', 'ABA']);
  });

  it('VI, VII and VIII have two notches, Z and M, as the right rotor', () => {
    for (const rotor of ['VI', 'VII', 'VIII']) {
      expect(positionsAfter(`I II ${rotor}`, 'A A L', 2)).toEqual(['AAM', 'ABN']);
      expect(positionsAfter(`I II ${rotor}`, 'A A Y', 2)).toEqual(['AAZ', 'ABA']);
    }
  });

  it('turns the left rotor with the middle one when the middle rotor stands on its notch', () => {
    // II has its notch at E: from ADU the middle rotor steps twice in a row (the double step).
    expect(positionsAfter('I II III', 'A D U', 5)).toEqual(['ADV', 'AEW', 'BFX', 'BFY', 'BFZ']);
    // The same without the right rotor's help: middle at E, right far from its notch.
    expect(positionsAfter('I II III', 'A E A', 2)).toEqual(['BFB', 'BFC']);
    // Middle rotor VI, VII or VIII in the middle: notches at Z and M.
    expect(positionsAfter('I VI III', 'A L A', 2)).toEqual(['ALB', 'ALC']);
    expect(positionsAfter('I VI III', 'A M A', 2)).toEqual(['BNB', 'BNC']);
    expect(positionsAfter('I VI III', 'A Z A', 2)).toEqual(['BAB', 'BAC']);
  });

  it('the Greek wheel of the M4 never moves', () => {
    const machine = new Enigma(
      readSetup({
        ...base,
        machine: 'm4',
        rotors: 'Gamma I II III',
        rings: 'A A A A',
        start: 'Q A D U',
        reflector: 'C-thin',
      }),
    );
    for (let i = 0; i < 100; i++) machine.press(i % 26);
    expect(lettersString(machine.pos)[0]).toBe('Q');
  });

  it('the cycle of the three rotors is 26 * 25 * 26 = 16900 key presses', () => {
    const machine = new Enigma(readSetup(base));
    for (let i = 0; i < 16900; i++) machine.press(0);
    expect(lettersString(machine.pos)).toBe('AAA');
  });
});

describe('ring settings', () => {
  it('shift the wiring against the letters but not the notches', () => {
    // Ring B and position B put the wiring in the same place as ring A and position A, so until a
    // turnover happens the two machines agree (the right rotor starts 1 position further, so its
    // notch comes 1 key earlier).
    const msg = 'ABCDEFGHIJKLMNOPQRST'; // 20 keys
    const a = enc(msg, { rings: 'A A A', start: 'A A A' });
    const b = enc(msg, { rings: 'B B B', start: 'B B B' });
    expect(b).toBe(a);
    // After the notch the two diverge: that is what the ring setting is for.
    const long = 'A'.repeat(60);
    expect(enc(long, { rings: 'B B B', start: 'B B B' })).not.toBe(enc(long));
  });

  it('numbers and letters are read alike', () => {
    expect(parsePositions('02 21 12', 3, 'rings')).toEqual(parsePositions('B U L', 3, 'rings'));
    expect(parsePositions('BUL', 3, 'rings')).toEqual([1, 20, 11]);
    expect(parsePositions('b,u,l', 3, 'rings')).toEqual([1, 20, 11]);
  });
});

describe('plugboard', () => {
  it('swaps letters before and after the rotors', () => {
    // With A<->B plugged, typing B is typing A: the lamp for A's answer is swapped too.
    const plain = enc('AAAAA');
    const plugged = enc('BBBBB', { plugboard: 'AB' });
    const swap = (s: string) => s.replace(/[AB]/g, (c) => (c === 'A' ? 'B' : 'A'));
    expect(plugged).toBe(swap(plain));
  });

  it('parses pairs in several spellings and rejects the rest', () => {
    expect(parsePlugboard('')).toEqual([]);
    expect(parsePlugboard('av bs, cg/dl')).toEqual([
      [0, 21],
      [1, 18],
      [2, 6],
      [3, 11],
    ]);
    expect(parsePlugboard('AVBSCG')).toHaveLength(3);
    expect(parsePlugboard('A-V B=S')).toHaveLength(2);
  });

  it('validates duplicates, self-connections, bad pairs and more than 13 pairs', () => {
    expect(() => parsePlugboard('AB AC')).toThrow(/two pairs/);
    expect(() => parsePlugboard('AB CA')).toThrow(/two pairs/);
    expect(() => parsePlugboard('AA')).toThrow(/itself/);
    expect(() => parsePlugboard('ABC DE')).toThrow(/pair/);
    expect(() => parsePlugboard('A1 CD')).toThrow(ToolError);
    // 13 pairs use all 26 letters: that is the most a plugboard takes, and a 14th pair must reuse one.
    const thirteen = 'AB CD EF GH IJ KL MN OP QR ST UV WX YZ';
    expect(parsePlugboard(thirteen)).toHaveLength(13);
    expect(() => parsePlugboard(`${thirteen} AY`)).toThrow(/two pairs/);
  });
});

describe('machines and settings', () => {
  it('reads rotor lists in several spellings', () => {
    expect(parseRotors('ii iv v', 'm3')).toEqual(['II', 'IV', 'V']);
    expect(parseRotors('2-4-5', 'enigma1')).toEqual(['II', 'IV', 'V']);
    expect(parseRotors('beta, II, IV, I', 'm4')).toEqual(['Beta', 'II', 'IV', 'I']);
    expect(parseRotors('Γ 1 2 3', 'm4')).toEqual(['Gamma', 'I', 'II', 'III']);
  });

  it('refuses rotors the machine never had, repeated rotors and wrong counts', () => {
    expect(() => parseRotors('I II VI', 'enigma1')).toThrow(/only had rotors I to V/);
    expect(() => parseRotors('I II III', 'm4')).toThrow(/4 rotors/);
    expect(() => parseRotors('Beta I II', 'm3')).toThrow(/Greek/);
    expect(() => parseRotors('I Beta II III', 'm4')).toThrow(/Greek wheel/);
    expect(() => parseRotors('II II III', 'm3')).toThrow(/twice/);
    expect(() => parseRotors('I II IX', 'm3')).toThrow(/not a rotor/);
    expect(() => parseRotors('I II', 'm3')).toThrow(/3 rotors/);
  });

  it('checks the reflector against the machine', () => {
    expect(() => readSetup({ ...base, reflector: 'B-thin' })).toThrow(/does not fit/);
    expect(() => readSetup({ ...base, machine: 'm4', rotors: 'Beta I II III' })).toThrow(
      /does not fit/,
    );
    expect(() => readSetup({ ...base, machine: 'm3', reflector: 'A' })).toThrow(/does not fit/);
    expect(readSetup({ ...base, reflector: 'A' }).reflector).toBe('A');
  });

  it('reports bad ring or start values', () => {
    expect(() => parsePositions('A A', 3, 'Ring settings')).toThrow(/3 values/);
    expect(() => parsePositions('A A 27', 3, 'Ring settings')).toThrow(/27/);
    expect(() => parsePositions('A A 0', 3, 'Ring settings')).toThrow(ToolError);
  });

  it('knows which rotors each machine could hold', () => {
    expect(MACHINES.enigma1.rotors).toEqual(['I', 'II', 'III', 'IV', 'V']);
    expect(MACHINES.m3.rotors).toHaveLength(8);
    expect(MACHINES.m4.wheels).toBe(4);
    expect(parseRotorPool('', 'enigma1')).toHaveLength(5);
    expect(parseRotorPool('i, ii iii', 'm3')).toEqual(['I', 'II', 'III']);
    expect(() => parseRotorPool('I II', 'm3')).toThrow(/three/);
    expect(() => parseRotorPool('I II VI', 'enigma1')).toThrow(/only had/);
  });
});

// ---------------------------------------------------------------------------------------------
// Round trips on every machine
// ---------------------------------------------------------------------------------------------

function randomSetup(rand: () => number, machine: MachineId): EnigmaSetup {
  const info = MACHINES[machine];
  const rotors = [...info.rotors];
  const pick: string[] = [];
  const turning = 3;
  for (let i = 0; i < turning; i++)
    pick.push(rotors.splice(Math.floor(rand() * rotors.length), 1)[0]!);
  const names = machine === 'm4' ? [GREEK_NAMES[Math.floor(rand() * 2)]!, ...pick] : pick;
  const letters = (): number[] => names.map(() => Math.floor(rand() * 26));
  const free = Array.from({ length: 26 }, (_, i) => i);
  const plugs: [number, number][] = [];
  for (let k = Math.floor(rand() * 14); k > 0; k--) {
    const a = free.splice(Math.floor(rand() * free.length), 1)[0]!;
    const b = free.splice(Math.floor(rand() * free.length), 1)[0]!;
    plugs.push([a, b]);
  }
  const reflector = info.reflectors[Math.floor(rand() * info.reflectors.length)]!;
  return { machine, rotors: names, reflector, rings: letters(), start: letters(), plugs };
}

describe('round trips', () => {
  it('encrypting twice with the same settings gives the plaintext back, on every machine', () => {
    const rand = makeRng(1930);
    for (const machine of ['enigma1', 'm3', 'm4'] as const) {
      for (let n = 0; n < 40; n++) {
        const setup = randomSetup(rand, machine);
        const len = 1 + Math.floor(rand() * 400);
        const plain = Array.from({ length: len }, () => Math.floor(rand() * 26));
        const cipher = runLetters(setup, plain);
        expect(runLetters(setup, cipher)).toEqual(plain);
        // The Enigma never maps a letter to itself.
        cipher.forEach((c, i) => expect(c).not.toBe(plain[i]));
      }
    }
  });

  it('the step table path agrees with the fast path', () => {
    const rand = makeRng(42);
    for (const machine of ['enigma1', 'm3', 'm4'] as const) {
      const setup = randomSetup(rand, machine);
      const plain = Array.from({ length: 60 }, () => Math.floor(rand() * 26));
      const fast = new Enigma(setup);
      const slow = new Enigma(setup);
      for (const v of plain) {
        const t = slow.trace(v);
        expect(t.output).toBe(fast.press(v));
        expect(t.input).toBe(v);
        expect(t.after).toEqual(Array.from(fast.pos));
        expect(t.forward).toHaveLength(setup.rotors.length);
        expect(t.backward).toHaveLength(setup.rotors.length);
      }
    }
  });

  it('flags the moves of the step table: right always, middle on the notch, left with the middle', () => {
    const machine = new Enigma(readSetup({ ...base, start: 'A D U' }));
    const t = [machine.trace(0), machine.trace(0), machine.trace(0), machine.trace(0)];
    expect(t.map((x) => x.moved)).toEqual([
      [false, false, true],
      [false, true, true],
      [true, true, true],
      [false, false, true],
    ]);
    expect(t.map((x) => x.doubleStep)).toEqual([false, false, true, false]);
    expect(t[1]!.before).toEqual([0, 3, 21]);
    expect(t[1]!.after).toEqual([0, 4, 22]);
  });
});

// ---------------------------------------------------------------------------------------------
// Text handling
// ---------------------------------------------------------------------------------------------

describe('transformText', () => {
  const fresh = () => new Enigma(readSetup(base));

  it('keeps other characters in place, and the case, or drops them', () => {
    const kept = transformText(fresh(), 'Hello, World 42!', { keep: true, group: false });
    expect(kept.text).toBe('Ilbda, Amtaz 42!');
    expect(kept.letters).toBe(10);
    expect(kept.others).toBe(4); // , 4 2 !
    const dropped = transformText(fresh(), 'Hello, World 42!', { keep: false, group: false });
    expect(dropped.text).toBe('ILBDAAMTAZ');
  });

  it('groups by five and counts letters the machine does not know', () => {
    const grouped = transformText(fresh(), 'Hello Wörld, Straße', { keep: false, group: true });
    expect(grouped.text).toMatch(/^[A-Z]{5}( [A-Z]{5})* ?[A-Z]{0,5}$/);
    expect(grouped.foreign).toBe(2); // ö, ß
    expect(grouped.letters).toBe(14);
    const lastBlock = grouped.text.split(' ').at(-1)!;
    expect(lastBlock.length).toBeLessThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------------------------
// Crib tools
// ---------------------------------------------------------------------------------------------

const toLetters = (s: string): number[] => letterValues(s);
const samplePath = (name: string) => new URL(`../../../public/samples/${name}`, import.meta.url);
const sampleCipher = (name: string): number[] =>
  letterValues(readFileSync(samplePath(name), 'utf8'));

describe('crib placements', () => {
  it('rules out the places where a letter meets itself, and no others', () => {
    // BDZGO is the cipher of AAAAA: the crib AAAAA fits, a crib starting with B does not.
    const cipher = toLetters('BDZGOXBDZGO');
    const aaa = cribPlacements(cipher, toLetters('AAAAA'));
    expect(aaa.every((p) => p.possible)).toBe(true);
    const bdz = cribPlacements(cipher, toLetters('BDZ'));
    expect(bdz.filter((p) => !p.possible).map((p) => p.start)).toEqual([0, 6]);
    expect(bdz[0]).toEqual({ start: 0, possible: false, clash: 0 });
    const shifted = cribPlacements(toLetters('XBDZ'), toLetters('QBQ'));
    expect(shifted.map((p) => [p.start, p.clash])).toEqual([
      [0, 1],
      [1, -1],
    ]);
  });

  it('never rules out the real place of a crib, on random messages and settings', () => {
    const rand = makeRng(7);
    for (let n = 0; n < 60; n++) {
      const setup = randomSetup(rand, (['enigma1', 'm3', 'm4'] as const)[n % 3]!);
      const plain = Array.from({ length: 80 }, () => Math.floor(rand() * 26));
      const cipher = runLetters(setup, plain);
      const at = Math.floor(rand() * 60);
      const place = cribPlacements(cipher, plain.slice(at, at + 12))[at]!;
      expect(place.possible).toBe(true);
    }
  });
});

describe('stepping back', () => {
  it('finds the start state of every forward run, even across double steps', () => {
    const rand = makeRng(99);
    for (let n = 0; n < 200; n++) {
      const rotors = ['I', 'II', 'III', 'IV', 'V', 'VI'][Math.floor(rand() * 6)]!;
      const middle = ['II', 'IV', 'VII'][Math.floor(rand() * 3)]!;
      const start = [Math.floor(rand() * 26), Math.floor(rand() * 26), Math.floor(rand() * 26)] as [
        number,
        number,
        number,
      ];
      const setup: EnigmaSetup = {
        machine: 'm3',
        rotors: ['I', middle, rotors],
        reflector: 'B',
        rings: [0, 0, 0],
        start,
        plugs: [],
      };
      const count = Math.floor(rand() * 300);
      const machine = new Enigma(setup);
      for (let i = 0; i < count; i++) machine.press(0);
      const now: [number, number, number] = [machine.pos[0]!, machine.pos[1]!, machine.pos[2]!];
      const notch = (name: string) => {
        const set = new Uint8Array(26);
        for (const ch of rotorNotches(name)) set[ch.charCodeAt(0) - 65] = 1;
        return set;
      };
      const back = stepBack(now, count, notch(middle), notch(rotors));
      expect(back).toContainEqual(start);
      // Every state it names really leads there.
      for (const s of back) {
        const check = new Enigma({ ...setup, start: s });
        for (let i = 0; i < count; i++) check.press(0);
        expect(Array.from(check.pos)).toEqual(now);
      }
    }
  });

  it('says so when a state cannot be reached (the stepping has holes at the middle notch)', () => {
    // I-II-III: nothing steps into (B, E, A)?  After one press the right rotor has moved, so the
    // right letter is never A with the middle rotor on E unless the right rotor wrapped: pick a
    // state whose predecessor would need the right rotor on 'Z' without the V notch hit.
    const noNotch = new Uint8Array(26);
    expect(stepBack([0, 0, 0], 0, noNotch, noNotch)).toEqual([[0, 0, 0]]);
    expect(stepBack([0, 0, 1], 1, noNotch, noNotch)).toEqual([[0, 0, 0]]);
  });
});

const searchInput = (
  setup: SetupText,
  cipher: number[],
  crib: string,
  position: number | null,
  pool: readonly string[],
): CribSearchInput => {
  const s = readSetup(setup);
  const m4 = s.rotors.length === 4;
  return {
    machine: s.machine,
    reflector: s.reflector,
    rings: s.rings,
    greek: m4 ? { rotor: s.rotors[0]!, start: s.start[0]! } : null,
    plugs: s.plugs,
    pool,
    cipher,
    crib: toLetters(crib),
    position,
    deadline: Date.now() + 60_000,
  };
};

describe('crib search', () => {
  it('finds the M3 sample setting with the crib at a known position (all 336 rotor orders)', () => {
    const cipher = sampleCipher(SAMPLE_M3.file);
    const t0 = Date.now();
    const res = searchCrib(
      searchInput(SAMPLE_M3.settings, cipher, 'WETTERBERICHT', 0, MACHINES.m3.rotors),
    );
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(res.orders).toBe(336);
    expect(res.ordersDone).toBe(336);
    expect(res.timedOut).toBe(false);
    expect(res.hits).toHaveLength(1);
    const hit = res.hits[0]!;
    expect(hit.order).toEqual(['VII', 'V', 'II']);
    expect(hit.starts.map((s) => lettersString(s))).toEqual(['KCT']);
    expect(res.expectedChance).toBeLessThan(1e-6);
  });

  it('finds it with no position given, for a crib in the middle of the message', () => {
    const cipher = sampleCipher(SAMPLE_M3.file);
    const plain = SAMPLE_M3.plain;
    const crib = 'BESONDERENXEREIGNISSE';
    const at = plain.indexOf(crib);
    expect(at).toBeGreaterThan(50);
    const input = searchInput(SAMPLE_M3.settings, cipher, crib, null, MACHINES.m3.rotors);
    const res = searchCrib(input);
    expect(res.placements).toBeGreaterThan(10);
    expect(res.ordersDone).toBe(336);
    const real = res.hits.find((h) => h.order.join() === 'VII,V,II');
    expect(real).toBeDefined();
    expect(real!.at).toBe(at);
    expect(real!.starts.map((s) => lettersString(s))).toContain('KCT');
    // The whole message then reads as the plaintext.
    expect(lettersString(decryptWithHit(input, real!))).toBe(plain);
    // Nothing else matched by chance.
    expect(res.hits).toHaveLength(1);
  });

  it('finds the M4 setting: Greek wheel and its position are given, the rest is searched', () => {
    const cipher = sampleCipher(SAMPLE_M4.file);
    const crib = 'FLAGENIGMA';
    const at = SAMPLE_M4.plain.indexOf(crib);
    const input = searchInput(SAMPLE_M4.settings, cipher, crib, at, MACHINES.m4.rotors);
    expect(input.greek).toEqual({ rotor: 'Beta', start: 9 });
    const res = searchCrib(input);
    expect(res.ordersDone).toBe(336);
    expect(res.hits).toHaveLength(1);
    expect(res.hits[0]!.order).toEqual(['VI', 'I', 'III']);
    expect(lettersString(decryptWithHit(input, res.hits[0]!))).toBe(SAMPLE_M4.plain);
    // The first key press turns the left and middle rotors together (the middle rotor I stands on
    // its notch Q), so J X Q M and J Y R M reach the same state: both are right, and both are listed.
    expect(res.hits[0]!.starts.map((st) => `J${lettersString(st)}`)).toContain('JXQM');
  });

  it('uses the plugboard it is given, and does not find the setting without it', () => {
    const cipher = sampleCipher(SAMPLE_PLUG.file);
    const pool = MACHINES.enigma1.rotors;
    const right = searchCrib(searchInput(SAMPLE_PLUG.settings, cipher, 'FLAGENIGMA', 0, pool));
    expect(right.orders).toBe(60);
    expect(right.hits).toHaveLength(1);
    expect(right.hits[0]!.order).toEqual(['III', 'I', 'II']);
    expect(lettersString(right.hits[0]!.starts[0]!)).toBe('MWP');
    const without = searchCrib(
      searchInput({ ...SAMPLE_PLUG.settings, plugboard: '' }, cipher, 'FLAGENIGMA', 0, pool),
    );
    expect(without.hits.find((h) => h.order.join() === 'III,I,II')).toBeUndefined();
  });

  it('finds a start whose crib runs through a double step', () => {
    // From A D S the right rotor reaches its notch after 2 keys and the middle rotor then sits on
    // its own notch: the crib below covers the anomaly.
    const setup: SetupText = { ...base, start: 'A D S', rings: 'A A A' };
    const plain = 'ATTACKATDAWNXPLEASEREPLYIMMEDIATELY';
    const cipher = toLetters(enc(plain, setup));
    const res = searchCrib(searchInput(setup, cipher, 'ATTACKATDAWN', 0, MACHINES.enigma1.rotors));
    const real = res.hits.find((h) => h.order.join() === 'I,II,III');
    expect(real).toBeDefined();
    expect(real!.starts.map((s) => lettersString(s))).toEqual(['ADS']);
  });

  it('restricts the search to the rotors it is given and reports a time-out honestly', () => {
    const cipher = sampleCipher(SAMPLE_M3.file);
    const small = searchCrib(
      searchInput(SAMPLE_M3.settings, cipher, 'WETTERBERICHT', 0, ['V', 'VII', 'II', 'I']),
    );
    expect(small.orders).toBe(24);
    expect(small.hits).toHaveLength(1);
    const late = searchCrib({
      ...searchInput(SAMPLE_M3.settings, cipher, 'WETTERBERICHT', 0, MACHINES.m3.rotors),
      deadline: 0,
    });
    expect(late.timedOut).toBe(true);
    expect(late.ordersDone).toBe(0);
    expect(late.hits).toEqual([]);
  });

  it('stops after maxHits for a crib so short that it matches everywhere', () => {
    const cipher = sampleCipher(SAMPLE_M3.file);
    const res = searchCrib({
      ...searchInput(SAMPLE_M3.settings, cipher, 'WET', null, MACHINES.m3.rotors),
      maxHits: 50,
    });
    expect(res.capped).toBe(true);
    expect(res.hits).toHaveLength(50);
    expect(res.ordersDone).toBeLessThan(336);
  });

  it('finds nothing in a ciphertext made with another rotor order or other rings', () => {
    const cipher = toLetters(
      enc('WETTERBERICHTXKEINEBESONDERENEREIGNISSE', { rotors: 'II V I', rings: 'A A A' }),
    );
    const res = searchCrib(
      searchInput({ ...base, rotors: 'II V I' }, cipher, 'WETTERBERICHT', 0, ['I', 'II', 'III']),
    );
    // The true order is not in the pool I-II-III.
    expect(res.hits).toEqual([]);
    const rings = toLetters(enc('WETTERBERICHTXKEINEBESONDERENEREIGNISSE', { rings: 'B C D' }));
    const wrong = searchCrib(searchInput(base, rings, 'WETTERBERICHT', 0, ['I', 'II', 'III']));
    // With rings A A A the real start cannot be reproduced once a notch is crossed; before that it
    // can (ring and start shift each other), so a hit is only valid for those first letters.
    for (const h of wrong.hits) expect(h.at).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------------------------

describe('samples', () => {
  it('the files in public/samples are what the engine makes', () => {
    for (const [name, content] of Object.entries(buildSamples())) {
      expect(readFileSync(samplePath(name), 'utf8')).toBe(content);
    }
  });

  it('every sample decrypts back to its made-up plaintext', () => {
    for (const s of [SAMPLE_M3, SAMPLE_M4, SAMPLE_PLUG]) {
      const cipher = readFileSync(samplePath(s.file), 'utf8');
      expect(enc(cipher, s.settings)).toBe(s.plain);
      expect(encryptLetters(s.settings, s.plain)).toBe(lettersString(letterValues(cipher)));
    }
  });
});

describe('the tool', () => {
  it('encrypts and decrypts with the same call (reciprocity)', () => {
    const plain = 'Keine besonderen Ereignisse';
    const opts = {
      rotors: 'IV V I',
      rings: 'C D E',
      start: 'X Y Z',
      plugboard: 'AB CD',
      other: 'drop',
    };
    const out = run(plain, opts);
    const cipher = (out[0] as { value: string }).value;
    const back = run(cipher, opts);
    expect((back[0] as { value: string }).value).toBe('KEINEBESONDERENEREIGNISSE');
  });

  it('shows the positions after the message, the wheels table and the step table', () => {
    const out = text('AAA', { start: 'A D U' });
    expect(out).toContain('Positions after the message: B F X');
    expect(out).toContain('Positions before');
    expect(out).toMatch(/Wirings/);
    // Row 3 of the step table is the double step.
    const table = run('AAA', { start: 'A D U' }).find(
      (o) => o.type === 'table' && o.columns.includes('Stepped'),
    );
    expect(table?.type === 'table' && table.rows).toHaveLength(3);
    expect(table?.type === 'table' && table.rows[2]![3]).toBe('L M R*');
  });

  it('limits the step table to the key presses asked for', () => {
    const out = run('A'.repeat(40), { steps: 5 });
    const table = out.find((o) => o.type === 'table' && o.columns.includes('Stepped'));
    expect(table?.type === 'table' && table.rows).toHaveLength(5);
    const none = run('A'.repeat(40), { steps: 0 });
    expect(none.some((o) => o.type === 'table' && o.columns.includes('Stepped'))).toBe(false);
  });

  it('the path table follows the current: plugboard, rotors, reflector, and back to the lamp', () => {
    const find = (out: Output[]) =>
      out.find((o) => o.type === 'table' && o.columns.includes('UKW')) as Extract<
        Output,
        { type: 'table' }
      >;
    // Enigma I, I II III, UKW-B: the first A lights B. Worked by hand: the right rotor (stepped to B)
    // sends A to C, then D, F; the reflector turns F round to S; S, E, B on the way back.
    const three = find(run('AAAAA'));
    expect(three.columns).toEqual([
      '#',
      'Key',
      'Plug',
      'R',
      'M',
      'L',
      'UKW',
      'L',
      'M',
      'R',
      'Plug',
      'Lamp',
    ]);
    expect(three.rows[0]).toEqual([1, 'A', 'A', 'C', 'D', 'F', 'S', 'S', 'E', 'B', 'B', 'B']);
    expect(three.rows.map((r) => r.at(-1)).join('')).toBe('BDZGO');
    // With a plugboard the key and the letter that enters the rotors differ, and so do the
    // letter that leaves them and the lamp.
    const plugged = find(run('AAAAA', { plugboard: 'AB' }));
    expect(plugged.rows[0]!.slice(1, 3)).toEqual(['A', 'B']);
    // Four wheels on the M4: the Greek wheel is the first and last rotor on the path.
    const four = find(
      run('AAAAA', {
        machine: 'm4',
        rotors: 'Beta I II III',
        rings: 'A A A A',
        start: 'A A A A',
      }),
    );
    expect(four.columns).toHaveLength(14);
    expect(four.columns.slice(3, 11)).toEqual(['R', 'M', 'L', 'G', 'UKW', 'G', 'L', 'M']);
    // M4 with Beta and UKW-B-thin at A is an M3: same lamps as BDZGO.
    expect(four.rows.map((r) => r.at(-1)).join('')).toBe('BDZGO');
  });

  it('groups by five only when other characters are dropped', () => {
    const grouped = run('AAAAAAAAAAAA', { other: 'drop', group: true });
    expect((grouped[0] as { value: string }).value).toBe('BDZGO WCXLT KS');
    const kept = run('AAAAA AAAAA', { other: 'keep', group: true });
    expect((kept[0] as { value: string }).value).toBe('BDZGO WCXLT');
  });

  it('shows the flag form when the plaintext starts with FLAG', () => {
    const cipher = encryptLetters(SAMPLE_PLUG.settings, SAMPLE_PLUG.plain);
    const out = text(cipher, {
      machine: 'enigma1',
      rotors: 'III I II',
      rings: 'C A F',
      start: 'M W P',
      plugboard: 'BQ CR DI EJ KW MT OS PX UZ GH',
      other: 'drop',
    });
    expect(out).toContain('flag{enigmarotorsstep}');
  });

  it('works on an M4 with all four rings and starts', () => {
    const out = text(readFileSync(samplePath(SAMPLE_M4.file), 'utf8'), {
      other: 'drop',
      machine: 'm4',
      rotors: 'Beta VI I III',
      reflectorThin: 'B-thin',
      rings: 'A A B C',
      start: 'J X Q M',
    });
    expect(out).toContain('FLAGENIGMAFOURWHEELS');
    expect(out).toContain('Positions after the message');
  });

  it('says what is wrong instead of failing', () => {
    expect(() => run('hello', { rotors: 'I II' })).toThrow(/3 rotors/);
    expect(() => run('hello', { machine: 'm4' })).toThrow(/4 rotors/);
    expect(() => run('hello', { plugboard: 'AB BC' })).toThrow(/two pairs/);
    expect(() => run('hello', { rings: 'A A' })).toThrow(/3 values/);
    expect(() => run('123 !!', {})).toThrow(/no letters/);
  });

  it('notes letters the machine cannot take, in both modes', () => {
    expect(text('Größe', { other: 'keep' })).toMatch(/not encrypted/);
    expect(text('Größe', { other: 'drop' })).toMatch(/left out/);
  });

  it('crib positions: lists where the crib can sit', () => {
    const cipher = readFileSync(samplePath(SAMPLE_M3.file), 'utf8');
    const out = run(cipher, { mode: 'drag', crib: 'WETTERBERICHT' });
    const kv = out.find((o) => o.type === 'kv');
    expect(
      kv?.type === 'kv' && kv.entries.find(([k]) => k === 'Places along the message'),
    ).toBeDefined();
    const table = out.find((o) => o.type === 'table');
    expect(table?.type === 'table' && table.rows[0]![3]).toBe('possible');
    expect(text(cipher, { mode: 'drag', crib: 'WETTERBERICHT' })).toContain(
      'never encrypts a letter to itself',
    );
  });

  it('crib search: finds the sample setting and offers to use it', () => {
    const cipher = readFileSync(samplePath(SAMPLE_M3.file), 'utf8');
    const out = run(cipher, {
      mode: 'crib',
      machine: 'm3',
      crib: 'WETTERBERICHT',
      cribPos: 1,
      budget: 60,
    });
    const flat = resultToText(out);
    expect(flat).toContain('336 of 336');
    expect(flat).toContain('VII V II');
    expect(flat).toContain('K C T');
    const actions = out.find((o) => o.type === 'actions');
    expect(actions?.type === 'actions' && actions.actions[0]!.options).toEqual({
      mode: 'crypt',
      rotors: 'VII V II',
      start: 'K C T',
    });
    // The note about the plugboard is always there.
    expect(flat).toContain('bombe');
    // The whole message, decrypted with the best setting, is shown in the clear.
    const best = out.find((o) => o.type === 'text' && o.label?.startsWith('Message decrypted'));
    expect(best?.type === 'text' && best.value).toBe(SAMPLE_M3.plain);
  });

  it('crib search: a plugboard that is given is used, and an unknown one is explained', () => {
    const cipher = readFileSync(samplePath(SAMPLE_PLUG.file), 'utf8');
    const common = {
      mode: 'crib',
      crib: 'FLAGENIGMA',
      cribRotors: 'I II III IV V',
      rings: 'C A F',
    };
    const found = run(cipher, { ...common, plugboard: SAMPLE_PLUG.settings.plugboard });
    expect(resultToText(found)).toContain('III I II');
    expect(resultToText(found)).toContain('M W P');
    expect(resultToText(found)).toContain('Plugboard: BQ CR DI EJ KW MT OS PX UZ GH');
    // Without the plugboard nothing fits, and the note says why that can be.
    const none = resultToText(run(cipher, common));
    expect(none).toContain('Settings found: 0');
    expect(none).toContain('a real plugboard hides the crib');
  });

  it('crib search: restricts the rotors, and says when a crib is too short to mean anything', () => {
    const cipher = readFileSync(samplePath(SAMPLE_M3.file), 'utf8');
    const narrow = resultToText(
      run(cipher, { mode: 'crib', machine: 'm3', crib: 'WETTERBERICHT', cribRotors: 'II V VII' }),
    );
    expect(narrow).toContain('6 of 6');
    // Four letters and no position: far too many chance matches, the search stops by itself.
    const short = resultToText(run(cipher, { mode: 'crib', machine: 'm3', crib: 'WETT' }));
    expect(short).toContain('Stopped at 200 settings');
    expect(() => run(cipher, { mode: 'crib', crib: 'WETTER', cribRotors: 'I II' })).toThrow(
      /three/,
    );
    expect(() => run(cipher, { mode: 'crib', crib: 'WETTER', cribRotors: 'I II VI' })).toThrow(
      /only had rotors I to V/,
    );
  });

  it('crib search: says when the same message state comes from two start positions', () => {
    const cipher = readFileSync(samplePath(SAMPLE_M4.file), 'utf8');
    const flat = resultToText(
      run(cipher, {
        mode: 'crib',
        machine: 'm4',
        crib: 'FLAGENIGMA',
        cribPos: 19,
        rings: 'A A B C',
        greekStart: 'J',
      }),
    );
    expect(flat).toContain('J Y R M / J X Q M');
    expect(flat).toContain('both decrypt the whole message the same way');
  });

  it('crib search: explains an impossible crib and a too short one', () => {
    const cipher = readFileSync(samplePath(SAMPLE_M3.file), 'utf8');
    const first = cipher.replace(/[^A-Z]/g, '')[0]!;
    expect(() => run(cipher, { mode: 'crib', crib: 'WET' })).toThrow(/at least 4/);
    expect(() => run(cipher, { mode: 'crib', crib: '' })).toThrow(/Enter a crib/);
    expect(() => run(cipher, { mode: 'crib', crib: `${first}ABCDEF`, cribPos: 1 })).toThrow(
      /never encrypts a letter to itself/,
    );
    expect(() => run('ABC', { mode: 'crib', crib: 'ABCDEF' })).toThrow(/longer than/);
    expect(() => run(cipher, { mode: 'crib', crib: 'WETTER', cribPos: 5000 })).toThrow(
      /cannot start at/,
    );
  });

  it('the examples all name machines and settings the engine accepts', () => {
    for (const ex of tool.examples) expect(ex.expect.length).toBeGreaterThan(0);
  });

  it('stays fast on big inputs (the tables are bounded, the search steps back cheaply)', () => {
    const rand = makeRng(5);
    const plain = Array.from({ length: 300_000 }, () =>
      String.fromCharCode(65 + Math.floor(rand() * 26)),
    ).join('');
    const t0 = Date.now();
    const out = run(plain, { other: 'drop', steps: 10 });
    expect((out[0] as { value: string }).value).toHaveLength(300_000);
    const cipher = (out[0] as { value: string }).value;
    // The tables stay small whatever the message length.
    const tables = out.filter((o) => o.type === 'table');
    expect(tables.every((t) => t.type === 'table' && t.rows.length <= 10)).toBe(true);
    // Crib positions of a crib that really is in the message, 200 000 letters in.
    const at = 200_000;
    const drag = run(cipher, { mode: 'drag', crib: plain.slice(at, at + 12) });
    const grid = drag.find((o) => o.type === 'table');
    expect(grid?.type === 'table' && grid.rows.length).toBeLessThanOrEqual(300);
    // The search steps back 200 000 key presses from the state in front of the crib.
    const found = run(cipher, {
      mode: 'crib',
      crib: plain.slice(at, at + 12),
      cribPos: at + 1,
      cribRotors: 'I II III',
      budget: 60,
    });
    expect(resultToText(found)).toContain('I II III');
    expect(resultToText(found)).toContain('A A A');
    expect(Date.now() - t0).toBeLessThan(15_000);
  });

  it('detects mentions of the machine', () => {
    const d = tool.detect?.({
      text: 'Walzenlage II IV V, Ringstellung 02 21 12',
      bytes: new Uint8Array(),
    });
    expect(d?.score).toBeGreaterThanOrEqual(0.5);
    expect(tool.detect?.({ text: 'just some words', bytes: new Uint8Array() })).toBeNull();
  });

  it('detects radio traffic: capital letters in groups with a flat letter distribution', () => {
    const cipher = readFileSync(samplePath(SAMPLE_M3.file), 'utf8');
    const d = tool.detect?.({ text: cipher, bytes: new Uint8Array() });
    expect(d?.score).toBe(0.3);
    // The plain German text of the sample, in the same groups, is not flat.
    const plain = formatGroups(SAMPLE_M3.plain);
    expect(tool.detect?.({ text: plain, bytes: new Uint8Array() })).toBeNull();
    // Short or lower-case text is not radio traffic.
    expect(tool.detect?.({ text: cipher.toLowerCase(), bytes: new Uint8Array() })).toBeNull();
    expect(tool.detect?.({ text: 'BCCBA FAUEP', bytes: new Uint8Array() })).toBeNull();
  });
});
