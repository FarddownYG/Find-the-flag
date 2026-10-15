import { bool, defineTool, number, select, text, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import { flagForm, iocOfValues } from './_classical';
import {
  Enigma,
  GREEK_NAMES,
  MACHINES,
  letterOf,
  letterValues,
  lettersString,
  machineName,
  parsePlugboard,
  parsePositions,
  parseRotorPool,
  readSetup,
  reflectorName,
  reflectorWiring,
  rotorNotches,
  rotorWiring,
  transformText,
  type EnigmaSetup,
  type MachineId,
  type PressTrace,
  type ReflectorId,
} from './_enigma';
import { BARBAROSSA, SAMPLE_M3, SAMPLE_M4, SAMPLE_PLUG, U264 } from './_enigma-samples';
import {
  cribPlacements,
  decryptWithHit,
  searchCrib,
  type CribHit,
  type CribSearchInput,
} from './_enigma-search';

const T = toolT('enigma');

/** A crib this short matches too many settings by pure chance to say anything. */
const MIN_CRIB = 4;
/** Rows shown of the crib positions table and of the settings found. */
const MAX_PLACEMENT_ROWS = 300;
const MAX_HIT_ROWS = 25;
/** Letters of the best decryption shown in full. */
const MAX_TEXT = 4000;
/** A crib that short matches by chance: stop collecting settings after this many. */
const MAX_HITS = 200;

interface Settings {
  mode: 'crypt' | 'crib' | 'drag';
  machine: MachineId;
  rotors: string;
  reflector: ReflectorId;
  reflectorThin: ReflectorId;
  rings: string;
  start: string;
  plugboard: string;
  other: 'keep' | 'drop';
  group: boolean;
  steps: number;
  crib: string;
  cribPos: number;
  cribRotors: string;
  greek: string;
  greekStart: string;
  budget: number;
}

const spaced = (values: ArrayLike<number>): string => lettersString(values, ' ');
const numbered = (values: readonly number[]): string =>
  `${spaced(values)} (${values.map((v) => String(v + 1).padStart(2, '0')).join(' ')})`;

const noteOf = (level: 'info' | 'warn' | 'error' | 'success', text: string): Output => ({
  type: 'note',
  level,
  text,
});

function wheelNames(machine: MachineId): string[] {
  const names = [T('wheel.left'), T('wheel.middle'), T('wheel.right')];
  return machine === 'm4' ? [T('wheel.greek'), ...names] : names;
}

function setupOf(o: Settings): EnigmaSetup {
  return readSetup({
    machine: o.machine,
    rotors: o.rotors,
    reflector: o.machine === 'm4' ? o.reflectorThin : o.reflector,
    rings: o.rings,
    start: o.start,
    plugboard: o.plugboard,
  });
}

const pairsText = (plugs: EnigmaSetup['plugs']): string =>
  plugs.length ? plugs.map(([a, b]) => letterOf(a) + letterOf(b)).join(' ') : T('value.none');

// ---------------------------------------------------------------- encrypt / decrypt

/** Wheel symbols, left to right: G (the M4's Greek wheel), L, M, R. */
const wheelSymbols = (setup: EnigmaSetup): string[] =>
  setup.rotors.length === 4 ? ['G', 'L', 'M', 'R'] : ['L', 'M', 'R'];

/** The first key presses: where the rotors stood, which ones stepped, where they stood then. */
function stepsTable(traces: readonly PressTrace[], symbols: readonly string[]): Output {
  return {
    type: 'table',
    label: T('label.steps'),
    columns: ['#', T('col.key'), T('col.before'), T('col.stepped'), T('col.used')],
    rows: traces.map((t, i) => [
      i + 1,
      letterOf(t.input),
      spaced(t.before),
      symbols.filter((_, w) => t.moved[w]).join(' ') + (t.doubleStep ? '*' : ''),
      spaced(t.after),
    ]),
  };
}

/** The same key presses: the letter after the plugboard, each rotor, the reflector, and back. */
function pathTable(traces: readonly PressTrace[], symbols: readonly string[]): Output {
  return {
    type: 'table',
    label: T('label.path'),
    columns: [
      '#',
      T('col.key'),
      T('col.plug'),
      ...[...symbols].reverse(),
      T('col.reflector'),
      ...symbols,
      T('col.plug'),
      T('col.lamp'),
    ],
    rows: traces.map((t, i) => [
      i + 1,
      letterOf(t.input),
      letterOf(t.plugIn),
      ...t.forward.map(letterOf),
      letterOf(t.reflected),
      ...t.backward.map(letterOf),
      letterOf(t.plugOut),
      letterOf(t.output),
    ]),
  };
}

function wheelsTable(setup: EnigmaSetup, end: ArrayLike<number>): Output {
  const names = wheelNames(setup.machine);
  const rows = setup.rotors.map((rotor, i) => [
    names[i]!,
    rotor,
    rotorNotches(rotor) ? [...rotorNotches(rotor)].join(' ') : '–',
    letterOf(setup.rings[i]!),
    letterOf(setup.start[i]!),
    letterOf(end[i]!),
  ]);
  return {
    type: 'table',
    label: T('label.wheels'),
    columns: [
      T('col.wheel'),
      T('col.rotor'),
      T('col.notch'),
      T('col.ring'),
      T('col.startLetter'),
      T('col.endLetter'),
    ],
    rows,
  };
}

/** What each contact is wired to: one line per rotor and for the reflector. */
function wiringsBlock(setup: EnigmaSetup): Output {
  return {
    type: 'kv',
    label: T('label.wirings'),
    entries: [
      ...setup.rotors.map((rotor): [string, string] => [rotor, rotorWiring(rotor)]),
      [reflectorName(setup.reflector), reflectorWiring(setup.reflector)],
    ],
  };
}

function crypt(input: string, o: Settings): Output[] {
  if (!/[A-Za-z]/.test(input)) throw new ToolError(T('error.noLetters'));
  const setup = setupOf(o);
  const machine = new Enigma(setup);
  const grouped = o.group && o.other === 'drop';
  const res = transformText(machine, input, { keep: o.other === 'keep', group: grouped });
  const out: Output[] = [{ type: 'text', label: T('label.result'), value: res.text }];
  const flag = flagForm(res.text.replace(/[^A-Za-z]/g, ''));
  if (flag) out.push({ type: 'text', label: T('label.flag'), value: flag });
  out.push(noteOf('info', T('note.reciprocal')));
  out.push({
    type: 'kv',
    label: T('label.setup'),
    entries: [
      [T('kv.machine'), machineName(setup.machine)],
      [T('kv.rotors'), setup.rotors.join(' ')],
      [T('kv.reflector'), reflectorName(setup.reflector)],
      [T('kv.rings'), numbered(setup.rings)],
      [T('kv.start'), spaced(setup.start)],
      [T('kv.end'), spaced(machine.pos)],
      [T('kv.plugboard'), pairsText(setup.plugs)],
      [T('kv.letters'), String(res.letters)],
    ],
  });
  out.push(wheelsTable(setup, machine.pos), wiringsBlock(setup));

  const shown = letterValues(input).slice(0, Math.max(0, Math.round(o.steps)));
  if (shown.length) {
    const tracer = new Enigma(setup);
    const traces = shown.map((v) => tracer.trace(v));
    const symbols = wheelSymbols(setup);
    out.push(
      stepsTable(traces, symbols),
      noteOf('info', T('note.stepsLegend')),
      pathTable(traces, symbols),
      noteOf('info', T('note.pathLegend')),
    );
  }

  if (res.foreign) {
    const count = res.foreign;
    out.push(
      noteOf(
        'warn',
        o.other === 'keep' ? T('note.foreignKept', { count }) : T('note.foreignDropped', { count }),
      ),
    );
  } else if (res.others && o.other === 'drop') {
    out.push(noteOf('info', T('note.droppedOthers', { count: res.others })));
  }
  return out;
}

// ---------------------------------------------------------------- crib tools

function cribOf(o: Settings, message: readonly number[]): number[] {
  const crib = letterValues(o.crib);
  if (!crib.length) throw new ToolError(T('error.cribEmpty'));
  if (crib.length > message.length) {
    throw new ToolError(T('error.cribLong', { crib: crib.length, message: message.length }));
  }
  return crib;
}

function messageOf(input: string): number[] {
  const message = letterValues(input);
  if (!message.length) throw new ToolError(T('error.noLetters'));
  return message;
}

/** "WETTER" laid along the message: where it can sit, and where a letter would meet itself. */
function drag(input: string, o: Settings): Output[] {
  const message = messageOf(input);
  const crib = cribOf(o, message);
  const places = cribPlacements(message, crib);
  const possible = places.filter((p) => p.possible);
  const cribText = lettersString(crib);
  const rows = places
    .slice(0, MAX_PLACEMENT_ROWS)
    .map((p) => [
      p.start + 1,
      lettersString(message.slice(p.start, p.start + crib.length)),
      cribText,
      p.possible
        ? T('value.possible')
        : T('value.clash', { index: p.clash + 1, letter: letterOf(crib[p.clash]!) }),
    ]);
  const out: Output[] = [
    {
      type: 'kv',
      label: T('label.summary'),
      entries: [
        [T('kv.crib'), cribText],
        [T('kv.cribLength'), String(crib.length)],
        [T('kv.messageLength'), String(message.length)],
        [T('kv.places'), String(places.length)],
        [T('kv.possible'), String(possible.length)],
        [T('kv.ruledOut'), String(places.length - possible.length)],
      ],
    },
    {
      type: 'table',
      label: T('label.placements'),
      columns: [T('col.place'), T('col.cipherWindow'), T('col.cribRow'), T('col.verdict')],
      rows,
      highlight:
        possible.length < places.length
          ? places.slice(0, MAX_PLACEMENT_ROWS).flatMap((p, i) => (p.possible ? [i] : []))
          : undefined,
    },
  ];
  if (places.length > MAX_PLACEMENT_ROWS) {
    out.push(
      noteOf('info', T('note.placementsCut', { shown: MAX_PLACEMENT_ROWS, count: places.length })),
    );
  }
  out.push(noteOf('info', T('note.neverItself')));
  return out;
}

function cribSearchInput(o: Settings, message: number[], crib: number[]): CribSearchInput {
  const reflector = o.machine === 'm4' ? o.reflectorThin : o.reflector;
  const m4 = o.machine === 'm4';
  // Reuse the reading and checking of the normal setup: the rotors and start of the three turning
  // wheels are placeholders, the search replaces them.
  const placeholder = readSetup({
    machine: o.machine,
    rotors: m4 ? `${o.greek} I II III` : 'I II III',
    reflector,
    rings: o.rings,
    start: m4 ? `${o.greekStart} A A A` : 'A A A',
    plugboard: o.plugboard,
  });
  return {
    machine: o.machine,
    reflector,
    rings: placeholder.rings,
    greek: m4 ? { rotor: placeholder.rotors[0]!, start: placeholder.start[0]! } : null,
    plugs: placeholder.plugs,
    pool: parseRotorPool(o.cribRotors, o.machine),
    cipher: message,
    crib,
    position: o.cribPos > 0 ? Math.round(o.cribPos) - 1 : null,
    deadline: Date.now() + Math.max(1, o.budget) * 1000,
    maxHits: MAX_HITS,
  };
}

interface RankedHit {
  hit: CribHit;
  plain: number[];
  ioc: number;
}

function crack(input: string, o: Settings): Output[] {
  const message = messageOf(input);
  const crib = cribOf(o, message);
  if (crib.length < MIN_CRIB) throw new ToolError(T('error.cribShort', { min: MIN_CRIB }));
  const search = cribSearchInput(o, message, crib);
  const maxStart = message.length - crib.length;
  if (search.position !== null) {
    if (search.position < 0 || search.position > maxStart) {
      throw new ToolError(
        T('error.cribPosition', {
          position: search.position + 1,
          crib: crib.length,
          max: maxStart + 1,
        }),
      );
    }
    const clash = cribPlacements(message, crib).find((p) => p.start === search.position)!;
    if (!clash.possible) {
      throw new ToolError(
        T('error.cribClash', {
          position: search.position + 1,
          index: clash.clash + 1,
          letter: letterOf(crib[clash.clash]!),
        }),
      );
    }
  } else if (!cribPlacements(message, crib).some((p) => p.possible)) {
    throw new ToolError(T('error.cribNowhere'));
  }

  const started = Date.now();
  const res = searchCrib(search);
  const elapsed = Date.now() - started;

  // Rank the settings found by how much the whole message then reads like a language.
  const ranked: RankedHit[] = res.hits.map((hit) => {
    const plain = decryptWithHit(search, hit);
    return { hit, plain, ioc: iocOfValues(plain) };
  });
  const rankable = message.length >= 30;
  if (rankable) ranked.sort((a, b) => b.ioc - a.ioc);
  const textLike = (r: RankedHit) => rankable && r.ioc >= 0.055;
  const m4 = o.machine === 'm4';
  const rotorsOf = (h: CribHit) => (m4 ? [search.greek!.rotor, ...h.order] : h.order).join(' ');
  const startOf = (h: CribHit, i: number) => {
    const start = h.starts[i]!;
    return spaced(m4 ? [search.greek!.start, ...start] : start);
  };

  const out: Output[] = [];
  const plugs = parsePlugboard(o.plugboard);
  const ringsValues = parsePositions(o.rings, MACHINES[o.machine].wheels, T('label.rings'));
  out.push({
    type: 'kv',
    label: T('label.summary'),
    entries: [
      [T('kv.machine'), machineName(o.machine)],
      [T('kv.reflector'), reflectorName(search.reflector)],
      [T('kv.rings'), numbered(ringsValues)],
      [T('kv.plugboard'), pairsText(plugs)],
      [T('kv.crib'), lettersString(crib)],
      [
        T('kv.position'),
        search.position === null
          ? T('value.anyPlace', { count: res.placements })
          : T('value.atLetter', { position: search.position + 1 }),
      ],
      [T('kv.orders'), T('value.ordersDone', { done: res.ordersDone, total: res.orders })],
      [T('kv.found'), String(res.hits.length)],
      [T('kv.chance'), res.expectedChance < 0.01 ? '< 0.01' : res.expectedChance.toFixed(2)],
      [T('kv.time'), T('value.seconds', { seconds: (elapsed / 1000).toFixed(1) })],
    ],
  });

  if (!res.hits.length) {
    out.push(
      res.timedOut ? noteOf('warn', T('note.noneTimedOut')) : noteOf('info', T('note.none')),
    );
  } else {
    const shown = ranked.slice(0, MAX_HIT_ROWS);
    out.push({
      type: 'table',
      label: T('label.hits'),
      columns: ['#', T('col.rotors'), T('col.startAtMessage'), T('col.cribAt'), T('col.ioc')],
      rows: shown.map((r, i) => [
        i + 1,
        rotorsOf(r.hit),
        r.hit.starts.map((_, k) => startOf(r.hit, k)).join(' / '),
        r.hit.at + 1,
        rankable ? r.ioc.toFixed(3) : '–',
      ]),
      highlight: shown.flatMap((r, i) => (textLike(r) ? [i] : [])),
    });
    const best = lettersString(shown[0]!.plain);
    out.push({
      type: 'text',
      label: T('label.bestText'),
      value: best.length > MAX_TEXT ? `${best.slice(0, MAX_TEXT)}…` : best,
    });
    out.push({
      type: 'actions',
      label: T('label.apply'),
      actions: shown.slice(0, 3).map((r, i) => ({
        label: T('action.use', {
          rotors: rotorsOf(r.hit),
          start: startOf(r.hit, 0),
        }),
        options: { mode: 'crypt', rotors: rotorsOf(r.hit), start: startOf(r.hit, 0) },
        primary: i === 0 && textLike(r),
      })),
    });
    if (res.hits.length > shown.length) {
      out.push(noteOf('info', T('note.hitsCut', { shown: shown.length, count: res.hits.length })));
    }
    out.push(noteOf('info', T('note.ioc')));
    if (shown.some((r) => r.hit.starts.length > 1)) {
      out.push(noteOf('info', T('note.equivalentStarts')));
    }
  }
  if (res.timedOut) {
    out.push(
      noteOf(
        'warn',
        T('note.timedOut', { done: res.ordersDone, total: res.orders, seconds: o.budget }),
      ),
    );
  }
  if (res.capped) out.push(noteOf('warn', T('note.capped', { count: res.hits.length })));
  if (res.expectedChance >= 1) {
    out.push(noteOf('warn', T('note.chance', { count: Math.round(res.expectedChance) })));
  }
  out.push(noteOf('info', T('note.ringsFixed', { rings: spaced(ringsValues) })));
  out.push(noteOf('warn', T('note.plugboard')));
  return out;
}

// ---------------------------------------------------------------- the tool

const MACHINE_CHOICES = [
  { value: 'enigma1', label: 'Enigma I' },
  { value: 'm3', label: 'M3' },
  { value: 'm4', label: 'M4' },
] as const;

const OPTIONS = {
  mode: toggle('Mode', [
    { value: 'crypt', label: 'Encrypt / decrypt' },
    { value: 'crib', label: 'Crib search' },
    { value: 'drag', label: 'Crib positions' },
  ]),
  machine: toggle('Machine', MACHINE_CHOICES, undefined, {
    hint: 'Enigma I: Wehrmacht and Luftwaffe, rotors I-V. M3: Kriegsmarine, rotors I-VIII. M4: Kriegsmarine from 1942, four rotors with a Greek wheel and a thin reflector.',
    showIf: (v) => v.mode !== 'drag',
  }),
  rotors: text('Rotors, left to right', 'I II III', {
    placeholder: 'I II III   or   Beta II IV I',
    hint: 'Enigma I: I-V. M3: I-VIII. M4: Beta or Gamma first, then three of I-VIII. Write them in the order they sit in the machine.',
    showIf: (v) => v.mode === 'crypt',
  }),
  reflector: select(
    'Reflector',
    [
      { value: 'A', label: 'UKW-A' },
      { value: 'B', label: 'UKW-B' },
      { value: 'C', label: 'UKW-C' },
    ],
    'B',
    { showIf: (v) => v.mode !== 'drag' && v.machine !== 'm4' },
  ),
  reflectorThin: select(
    'Thin reflector',
    [
      { value: 'B-thin', label: 'UKW-B-thin' },
      { value: 'C-thin', label: 'UKW-C-thin' },
    ],
    'B-thin',
    { showIf: (v) => v.mode !== 'drag' && v.machine === 'm4' },
  ),
  rings: text('Ring settings', 'A A A', {
    placeholder: 'A A A   or   01 01 01',
    hint: 'Ringstellung of each rotor, left to right: letters A-Z or numbers 1-26. The M4 takes four, the Greek wheel first. In a crib search they stay fixed at this value.',
    showIf: (v) => v.mode !== 'drag',
  }),
  start: text('Start positions', 'A A A', {
    placeholder: 'A A A   or   B L A',
    hint: 'Grundstellung: the letters showing in the windows when the first key is pressed, left to right.',
    showIf: (v) => v.mode === 'crypt',
  }),
  plugboard: text('Plugboard', '', {
    placeholder: 'AV BS CG DL FU HZ IN KM OW RX',
    hint: 'Steckerbrett: letter pairs swapped before and after the rotors (up to 13, each letter once). Leave empty for none.',
    showIf: (v) => v.mode !== 'drag',
  }),
  other: toggle(
    'Other characters',
    [
      { value: 'keep', label: 'Keep' },
      { value: 'drop', label: 'Drop' },
    ],
    undefined,
    {
      hint: 'The machine only has the 26 letters A-Z. Spaces, digits and punctuation can stay where they are, or be removed.',
      showIf: (v) => v.mode === 'crypt',
    },
  ),
  group: bool('Group by 5', false, {
    hint: 'Letters only, in blocks of five, as radio operators sent them.',
    showIf: (v) => v.mode === 'crypt' && v.other === 'drop',
  }),
  steps: number('Key presses shown', 10, {
    min: 0,
    max: 100,
    hint: 'Rows of the step table: rotor positions and the path of the current for the first letters. 0 hides it.',
    showIf: (v) => v.mode === 'crypt',
  }),
  crib: text('Crib', '', {
    placeholder: 'WETTERBERICHT',
    hint: 'A piece of plaintext you expect, letters A-Z (other characters are ignored). Weather reports, greetings, "KEINE BESONDEREN EREIGNISSE"...',
    showIf: (v) => v.mode !== 'crypt',
  }),
  cribPos: number('Crib position', 0, {
    min: 0,
    max: 100000,
    hint: 'Number of the message letter where the crib starts (1 = first letter). 0 = unknown: every place it can sit is tried.',
    showIf: (v) => v.mode === 'crib',
  }),
  cribRotors: text('Rotors to try', '', {
    placeholder: 'all',
    hint: 'Narrow the search to these rotors, for example "I II III IV V". Empty = every rotor of the machine.',
    showIf: (v) => v.mode === 'crib',
  }),
  greek: select(
    'Greek wheel',
    GREEK_NAMES.map((g) => ({ value: g, label: g })),
    'Beta',
    { showIf: (v) => v.mode === 'crib' && v.machine === 'm4' },
  ),
  greekStart: text('Greek wheel position', 'A', {
    hint: 'The Greek wheel never turns: its position is taken as given.',
    showIf: (v) => v.mode === 'crib' && v.machine === 'm4',
  }),
  budget: number('Time limit (seconds)', 20, {
    min: 1,
    max: 120,
    hint: 'The search stops after this long and says how far it got.',
    showIf: (v) => v.mode === 'crib',
  }),
};

export default defineTool({
  id: 'enigma',
  name: 'Enigma machine',
  category: 'crypto',
  description:
    'Encrypt or decrypt with the Enigma I, M3 or M4 (rotors, rings, plugboard), follow every key press, or search a known plaintext for the rotors and start positions.',
  tags: [
    'enigma',
    'rotor',
    'rotor machine',
    'plugboard',
    'steckerbrett',
    'ringstellung',
    'grundstellung',
    'wehrmacht',
    'kriegsmarine',
    'u-boat',
    'bletchley',
    'bombe',
    'crib',
    'crib dragging',
    'turing',
    'm4',
    'm3',
  ],
  input: 'text',
  placeholder: 'Message or ciphertext: letters A-Z (the machine is its own inverse)…',
  options: OPTIONS,
  examples: [
    // Enigma I, rotors I II III, UKW-B, rings AAA, start AAA: the first test of every simulator.
    { label: 'Test vector: AAAAA', input: 'AAAAA', expect: 'BDZGO' },
    // From A D U the middle rotor steps twice in a row and takes the left one along.
    {
      label: 'Double stepping from ADU',
      input: 'AAA',
      options: { start: 'A D U' },
      expect: 'Positions after the message: B F X',
    },
    {
      label: 'Historic message: Operation Barbarossa (Enigma I)',
      input: BARBAROSSA.cipher,
      options: {
        rotors: BARBAROSSA.settings.rotors,
        rings: BARBAROSSA.settings.rings,
        start: BARBAROSSA.settings.start,
        plugboard: BARBAROSSA.settings.plugboard,
      },
      expect: 'AUFKL XABTE ILUNG XVONX KURTI NOWAX',
    },
    {
      label: 'Historic message: U-boat, 1942 (M4)',
      input: U264.cipher,
      options: {
        machine: 'm4',
        rotors: U264.settings.rotors,
        reflectorThin: 'B-thin',
        rings: U264.settings.rings,
        start: U264.settings.start,
        plugboard: U264.settings.plugboard,
      },
      expect: 'VONV ONJL OOKS JHFF TTTE',
    },
    {
      label: 'Encrypt a sentence in groups of five',
      input: 'Keine besonderen Ereignisse',
      options: {
        machine: 'm3',
        rotors: 'VIII III VI',
        reflector: 'C',
        rings: 'D H L',
        start: 'R O T',
        plugboard: 'AM FI NV PS TU WZ',
        other: 'drop',
        group: true,
      },
      expect: 'NQNTP EHHMX MGSAA DZPUE DLGLK',
    },
    {
      label: 'Decrypt a message that used a plugboard',
      input: { sample: SAMPLE_PLUG.file },
      options: {
        rotors: SAMPLE_PLUG.settings.rotors,
        rings: SAMPLE_PLUG.settings.rings,
        start: SAMPLE_PLUG.settings.start,
        plugboard: SAMPLE_PLUG.settings.plugboard,
        other: 'drop',
      },
      expect: 'flag{enigmarotorsstep}',
    },
    {
      label: 'Crib search: weather report (M3)',
      input: { sample: SAMPLE_M3.file },
      options: { mode: 'crib', machine: 'm3', crib: 'WETTERBERICHT' },
      expect: 'VII V II',
    },
    {
      label: 'Crib search: M4, position and Greek wheel given',
      input: { sample: SAMPLE_M4.file },
      options: {
        mode: 'crib',
        machine: 'm4',
        rings: SAMPLE_M4.settings.rings,
        crib: 'FLAGENIGMA',
        cribPos: 19,
        greek: 'Beta',
        greekStart: 'J',
      },
      expect: 'Beta VI I III',
    },
    {
      label: 'Crib positions: where can the crib sit?',
      input: { sample: SAMPLE_M3.file },
      options: { mode: 'drag', crib: 'WETTERBERICHT' },
      expect: 'Places not ruled out: 65',
    },
  ],
  detect({ text: t }) {
    if (!t) return null;
    if (
      /\b(enigma|walzenlage|ringstellung|grundstellung|steckerverbindungen|umkehrwalze)\b/i.test(t)
    ) {
      return { score: 0.5, reason: T('detect.keyword') };
    }
    // Radio traffic: capital letters in groups of four or five, with a flat letter distribution
    // (about 0.038). Plenty of other ciphers look like this, so the score stays low.
    if (t.length > 100_000) return null;
    const groups = t.trim().split(/\s+/);
    if (
      groups.length >= 10 &&
      groups.slice(0, -1).every((g) => /^[A-Z]{4,5}$/.test(g)) &&
      /^[A-Z]{1,5}$/.test(groups[groups.length - 1]!) &&
      iocOfValues(letterValues(t)) < 0.05
    ) {
      return { score: 0.3, reason: T('detect.groups') };
    }
    return null;
  },
  run(input, o: Settings) {
    if (o.mode === 'drag') return drag(input, o);
    if (o.mode === 'crib') return crack(input, o);
    return crypt(input, o);
  },
});
