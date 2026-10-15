import type { Output } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import { IOC_REFERENCE, MAX_PERIOD, type Stats } from './_cipher-identify-stats';

const T = toolT('cipher-identify');

/** The tables that show what was measured, each number with a line saying what it means. */

const f3 = (x: number): string => x.toFixed(3);
const no = (): string => T('value.no');
const pct = (x: number): string => (x * 100).toFixed(1);

/** One row: the name, then the number and, after a dash, what it means. */
const line = ([name, value, meaning]: [string, string, string]): [string, string] => [
  name,
  `${value} — ${meaning}`,
];

const langName = (lang: string | null): string =>
  lang === 'fr' ? T('lang.fr') : lang === 'en' ? T('lang.en') : T('value.none');

function alphabetText(s: Stats): string {
  const parts: string[] = [];
  if (s.letters) {
    parts.push(
      s.upper && s.lower
        ? T('value.alphabet.mixed')
        : s.lower
          ? T('value.alphabet.lower')
          : T('value.alphabet.upper'),
    );
  }
  if (s.digits) parts.push(T('value.alphabet.digits'));
  if (s.others) parts.push(T('value.alphabet.symbols', { list: s.otherSet.join(' ') }));
  if (s.spaces) parts.push(T('value.alphabet.spaces'));
  return parts.join(', ');
}

function simpleKeysText(s: Stats): string {
  const chi = (x: number): string => (Number.isFinite(x) ? String(Math.round(x)) : '–');
  return T('value.simple', {
    shift: s.caesar.b,
    caesar: chi(s.caesar.chi),
    a: s.affine.a,
    b: s.affine.b,
    affine: chi(s.affine.chi),
    atbash: chi(s.atbash.chi),
  });
}

/** The key length the periodic IoC points to, if it stands out clearly from the text as it is. */
function clearPeak(s: Stats): Stats['peak'] {
  const ioc1 = s.period[0]?.ioc ?? s.ioc;
  // A text that already has the IoC of a language has no key to find.
  return s.peak && ioc1 < 0.056 && s.peak.harmonic - ioc1 >= 0.01 && s.peak.harmonic >= 0.05
    ? s.peak
    : null;
}

/** "Statistic | Value | What it tells you" for the numbers every text has. */
export function statisticsTable(s: Stats): Output {
  const ioc1 = s.period[0]?.ioc ?? s.ioc;
  const peak = clearPeak(s);
  const rows: [string, string, string][] = [
    [
      T('stat.length'),
      T('value.length', {
        symbols: s.symbols,
        letters: s.letters,
        digits: s.digits,
        others: s.others,
      }),
      T('what.length'),
    ],
    [T('stat.alphabet'), alphabetText(s), T('what.alphabet')],
    [
      T('stat.distinct'),
      T('value.distinct', { count: s.distinct, letters: s.distinctLetters }),
      T('what.distinct'),
    ],
  ];
  if (s.letters >= 2) {
    rows.push(
      [
        T('stat.ioc'),
        T('value.ioc', {
          ioc: f3(s.ioc),
          en: IOC_REFERENCE.en.toFixed(3),
          fr: IOC_REFERENCE.fr.toFixed(3),
          random: IOC_REFERENCE.random.toFixed(3),
        }),
        T('what.ioc'),
      ],
      [
        T('stat.chi'),
        T('value.chi', { en: Math.round(s.chi.en), fr: Math.round(s.chi.fr) }),
        T('what.chi'),
      ],
      [T('stat.simple'), simpleKeysText(s), T('what.simple')],
      [
        T('stat.readability'),
        s.readability.lang && s.readability.score >= 10
          ? T('value.readability', {
              score: Math.round(s.readability.score),
              lang: langName(s.readability.lang),
            })
          : T('value.readabilityNone', { score: Math.round(s.readability.score) }),
        T('what.readability'),
      ],
    );
  }
  rows.push([
    T('stat.entropy'),
    T('value.entropy', { h: s.entropy.toFixed(2), max: s.entropyMax.toFixed(2) }),
    T('what.entropy'),
  ]);
  if (s.letters >= 8) {
    rows.push(
      [
        T('stat.period'),
        peak
          ? T('value.period', { period: peak.period, ioc: f3(peak.ioc), ioc1: f3(ioc1) })
          : T('value.none'),
        T('what.period'),
      ],
      [
        T('stat.digraphs'),
        T('value.digraphs', { aligned: s.align2.aligned, shifted: s.align2.shifted }),
        T('what.digraphs'),
      ],
    );
  }
  return { type: 'kv', label: T('label.statistics'), entries: rows.map(line) };
}

/** The yes/no clues. */
export function checksTable(s: Stats): Output {
  const rows: [string, string, string][] = [];
  const n = s.letters;

  if (n >= 2) {
    const rate = s.doubles.total / (n - 1);
    rows.push([
      T('check.doubles'),
      s.doubles.total
        ? T('value.doubles', {
            total: s.doubles.total,
            rate: pct(rate),
            inPairs: s.doubles.inPairs,
          })
        : T('value.doublesNone'),
      T('what.doubles'),
    ]);
  }
  rows.push([
    T('check.even'),
    s.symbols % 2 === 0
      ? T('value.evenYes', { count: s.symbols })
      : T('value.evenNo', { count: s.symbols }),
    T('what.even'),
  ]);
  if (n >= 20) {
    const j = s.missing.includes('J');
    rows.push([
      T('check.square'),
      n < 60
        ? T('value.squareShort', { count: n })
        : j && s.missing.length === 1
          ? T('value.squareJ')
          : j
            ? T('value.squareJMore', { others: s.missing.filter((c) => c !== 'J').join(' ') })
            : T('value.squareNo', { count: s.distinctLetters }),
      T('what.square'),
    ]);
  }
  rows.push([
    T('check.digitPairs'),
    s.digitsOnly
      ? s.coordinatePairs
        ? T('value.pairsYes', { digits: s.digitSet.join(' '), count: Math.floor(s.digits / 2) })
        : T('value.pairsNo')
      : T('value.pairsNotDigits'),
    T('what.digitPairs'),
  ]);
  rows.push([
    T('check.divisible'),
    s.divisors.length ? s.divisors.join(', ') : T('value.none'),
    T('what.divisible'),
  ]);
  rows.push([
    T('check.adfgvx'),
    s.adfgvx ? T('value.adfgvxYes', { letters: s.adfgvx.join(' ') }) : no(),
    T('what.adfgvx'),
  ]);
  rows.push([
    T('check.two'),
    s.twoSymbols ? T('value.twoYes', { a: s.twoSymbols[0]!, b: s.twoSymbols[1]! }) : no(),
    T('what.two'),
  ]);
  rows.push([
    T('check.groups'),
    s.groups.size !== null && s.groups.count > 2
      ? T('value.groupsYes', { count: s.groups.count, size: s.groups.size })
      : T('value.groupsNo'),
    T('what.groups'),
  ]);
  if (s.upper && s.lower) {
    rows.push([
      T('check.case'),
      T('value.case', {
        upper: s.upper,
        lower: s.lower,
        rate: pct(s.caseSwitches / Math.max(1, n - 1)),
      }),
      T('what.case'),
    ]);
  }
  return { type: 'kv', label: T('label.checks'), entries: rows.map(line) };
}

/** The index of coincidence of the columns for each width 1..20, with a bar. */
export function periodTable(s: Stats): Output[] {
  if (s.period.length < 2) return [];
  const peak = clearPeak(s)?.period;
  const rows = s.period.map((r) => [
    r.period,
    f3(r.ioc),
    '█'.repeat(Math.round((Math.min(r.ioc, 0.1) / 0.1) * 30)),
  ]);
  return [
    {
      type: 'table',
      label: T('label.periods', { max: MAX_PERIOD }),
      columns: [T('col.period'), 'IoC', ''],
      rows,
      highlight: peak ? [peak - 1] : [],
    },
    { type: 'note', level: 'info', text: T('note.periods') },
  ];
}

/** Repeated trigrams and the numbers that divide the distances between them. */
export function kasiskiTable(s: Stats): Output[] {
  const k = s.kasiski;
  if (k.repeats < 1) return [{ type: 'note', level: 'info', text: T('note.noRepeats') }];
  return [
    {
      type: 'table',
      label: T('label.kasiski', { repeats: k.repeats, longest: k.longest }),
      columns: [T('col.factor'), T('col.distances'), T('col.share')],
      rows: k.rows
        .slice(0, 6)
        .map((r) => [
          r.factor,
          `${r.votes} / ${k.repeats}`,
          `${Math.round((r.votes / k.repeats) * 100)} %`,
        ]),
    },
    { type: 'note', level: 'info', text: T('note.kasiski') },
  ];
}
