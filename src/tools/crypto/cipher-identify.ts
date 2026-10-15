import { defineTool, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import { registeredTools } from '../../core/tool-list';
import type { AnyTool, Output } from '../../core/types';
import type { Params } from '../../i18n';
import { toolName, toolT } from '../../i18n/tool-text';
import { findShapes } from './_cipher-identify-encodings';
import { rankFamilies, type Family, type FamilyId, type Reason } from './_cipher-identify-rank';
import { checksTable, kasiskiTable, periodTable, statisticsTable } from './_cipher-identify-report';
import { analyse, iocOfCounts, MAX_INPUT } from './_cipher-identify-stats';

const T = toolT('cipher-identify');

/** The most rows of the ranking, and how many of them come with their reasons and buttons. */
const SHOWN = 8;
const DETAILED = 4;
/** Families under this fit are not listed. */
const MIN_FIT = 15;
/** A match this strong (an encoding that decodes to text) is listed before the ciphers. */
const FIRST_FIT = 70;
/** detect() looks at this much of a pasted text: it runs for every tool on every paste. */
const DETECT_SCAN = 5000;

const FAMILY_NAME: Record<FamilyId, () => string> = {
  plain: () => T('family.plain'),
  transposition: () => T('family.transposition'),
  caesar: () => T('family.caesar'),
  atbash: () => T('family.atbash'),
  affine: () => T('family.affine'),
  substitution: () => T('family.substitution'),
  vigenere: () => T('family.vigenere'),
  playfair: () => T('family.playfair'),
  hill: () => T('family.hill'),
  bifid: () => T('family.bifid'),
  adfgx: () => T('family.adfgx'),
  polybius: () => T('family.polybius'),
  bacon: () => T('family.bacon'),
  flat: () => T('family.flat'),
};

interface Candidate {
  /** The family or the tool it stands for. */
  id: string;
  name: string;
  /** The name without the "Encoding:" label, for the verdict. */
  bare: string;
  score: number;
  why: string[];
  against: string[];
  links: { tool: AnyTool; options: Record<string, unknown> }[];
  /** An encoding (not a cipher). */
  encoding: boolean;
  /** An encoding (or a chain of them) that decodes to readable text. */
  decoded: boolean;
}

/** A reason as a sentence: the language code in its numbers becomes the language's name. */
function sentence(r: Reason): string {
  const params: Params = { ...r.params };
  if (typeof params.lang === 'string') params.lang = T(`lang.${params.lang}`);
  return T(r.key, params);
}

function fromFamily(f: Family, byId: Map<string, AnyTool>): Candidate {
  return {
    id: f.id,
    name: FAMILY_NAME[f.id](),
    bare: FAMILY_NAME[f.id](),
    score: f.score,
    why: f.reasons.map(sentence),
    against: f.against.map(sentence),
    links: f.links.flatMap((l) => {
      const tool = byId.get(l.tool);
      return tool ? [{ tool, options: l.options }] : [];
    }),
    encoding: false,
    decoded: false,
  };
}

/** The reasons of one candidate, one per row: what speaks for it, then what speaks against. */
function reasonsBlock(c: Candidate, rank: number): Output {
  return {
    type: 'kv',
    label: T('label.candidate', { rank, name: c.name, score: c.score }),
    entries: [
      ...c.why.map((w): [string, string] => [T('kv.for'), w]),
      ...c.against.map((w): [string, string] => [T('kv.against'), w]),
    ],
  };
}

/** The buttons of one candidate: its tools, with the options that fit it. */
function openBlock(c: Candidate, text: string, first: boolean): Output {
  return {
    type: 'actions',
    actions: c.links.slice(0, 3).map((link, i) => ({
      label: T('open', { tool: toolName(link.tool) }),
      options: link.options,
      primary: first && i === 0,
      open: { tool: link.tool.id, text },
    })),
  };
}

export default defineTool({
  id: 'cipher-identify',
  name: 'Cipher identifier',
  category: 'crypto',
  description:
    'Paste a ciphertext: index of coincidence, repeats and other statistics rank the likely ciphers and encodings, with a one-click Open in the right tool.',
  tags: [
    'identify cipher',
    'which cipher',
    'cipher detector',
    'cipher identifier',
    'dcode',
    'boxentriq',
    'index of coincidence',
    'ioc',
    'kasiski',
    'chi squared',
    'classical cipher',
    'ciphertext',
    'what is this',
    'cryptanalysis',
  ],
  input: 'text',
  placeholder: 'Paste the ciphertext you cannot identify…',
  options: {
    language: toggle('Plaintext language', [
      { value: 'auto', label: 'Auto' },
      { value: 'en', label: 'English' },
      { value: 'fr', label: 'French' },
    ]),
  },
  examples: [
    {
      label: 'Plain English sentence',
      input:
        'The old lighthouse keeper climbed the spiral stairs every evening, long before the first ' +
        'ships appeared on the horizon. He carried a lantern, a loaf of bread and a battered notebook.',
      expect: 'Plain language',
    },
    {
      label: 'Caesar shift, letters only',
      input: { sample: 'cipher-identify-caesar.txt' },
      expect: 'Caesar / ROT shift',
    },
    {
      label: 'Vigenère, key of 5 letters',
      input: { sample: 'cipher-identify-vigenere.txt' },
      expect: 'Vigenère family',
    },
    {
      label: 'Playfair',
      input: { sample: 'cipher-identify-playfair.txt' },
      expect: 'Playfair / Two-square / Four-square',
    },
    {
      label: 'Columnar transposition',
      input: { sample: 'cipher-identify-columnar.txt' },
      expect: 'Transposition',
    },
    {
      label: 'ADFGX',
      input: { sample: 'cipher-identify-adfgx.txt' },
      expect: 'ADFGX / ADFGVX',
    },
    {
      label: 'Polybius digit pairs',
      input: '44 23 15 13 23 11 31 31 15 33 22 15 43 44 11 42 44 15 14',
      expect: 'Polybius',
    },
    {
      label: 'Base64 text',
      input: { sample: 'cipher-identify-base64.txt' },
      expect: 'Base64',
    },
  ],
  detect({ text }) {
    if (!text) return null;
    const head = text.slice(0, DETECT_SCAN);
    const counts = new Array<number>(26).fill(0);
    let letters = 0;
    let symbols = 0;
    let spaces = 0;
    for (const ch of head) {
      const c = ch.charCodeAt(0) | 0x20;
      if (/\s/u.test(ch)) spaces++;
      else {
        symbols++;
        if (c >= 97 && c <= 122) {
          counts[c - 97]!++;
          letters++;
        }
      }
    }
    if (letters < 40 || letters < symbols * 0.85) return null;
    // Ordinary prose has spaces between words and the letters of a language: not a ciphertext.
    const ioc = iocOfCounts(counts, letters);
    const wordy = spaces >= letters / 12 && /[a-z]{2,}\s+[a-z]{2,}\s+[a-z]{2,}/.test(head);
    if (wordy && ioc >= 0.055) return null;
    return { score: 0.45, reason: T('detect.letters') };
  },
  async run(text, { language }) {
    if (!/\S/.test(text)) throw new ToolError(T('error.empty'));
    const stats = analyse(text, language);
    const byId = new Map(registeredTools().map((t) => [t.id, t] as const));

    const candidates: Candidate[] = rankFamilies(stats).map((f) => fromFamily(f, byId));
    for (const shape of await findShapes(text.slice(0, MAX_INPUT), stats)) {
      const link = { tool: shape.tool, options: shape.options };
      const own = shape.family ? candidates.find((c) => c.id === shape.family) : undefined;
      if (own) {
        own.score = Math.max(own.score, shape.score);
        own.why.push(...shape.reasons);
        const mine = own.links.find((l) => l.tool.id === shape.tool.id);
        // Where both name an option, the family's own choice (Find the key) wins.
        if (mine) mine.options = { ...shape.options, ...mine.options };
        else own.links.unshift(link);
        continue;
      }
      candidates.push({
        id: shape.family ?? shape.tool.id,
        bare: shape.family ? FAMILY_NAME[shape.family]() : toolName(shape.tool),
        name: shape.family
          ? FAMILY_NAME[shape.family]()
          : shape.encoding
            ? T('name.decoded', { tool: toolName(shape.tool) })
            : toolName(shape.tool),
        score: shape.score,
        why: shape.reasons,
        against: shape.against,
        links: [link],
        encoding: shape.encoding,
        decoded: shape.decoded,
      });
    }

    // An encoding that decodes to text explains the data far better than any cipher does.
    if (candidates.some((c) => c.decoded && c.score >= FIRST_FIT)) {
      for (const c of candidates) if (!c.decoded) c.score = Math.round(c.score * 0.5);
    }

    // Next to an encoding that decodes to text, a weak cipher guess is only noise.
    const floor = candidates.some((c) => c.decoded) ? 35 : MIN_FIT;
    const listed = candidates
      .filter((c) => c.score >= floor)
      .sort(
        (a, b) =>
          Number(b.encoding && b.score >= FIRST_FIT) - Number(a.encoding && a.score >= FIRST_FIT) ||
          b.score - a.score,
      )
      .slice(0, SHOWN);

    const out: Output[] = [];
    const top = listed[0];
    const second = listed[1];
    if (!top) {
      out.push({ type: 'note', level: 'warn', text: T('verdict.none') });
    } else if (top.encoding && top.score >= FIRST_FIT) {
      out.push({
        type: 'note',
        level: 'success',
        text: T('verdict.decoded', { name: top.bare }),
      });
    } else if (top.id === 'plain') {
      out.push({ type: 'note', level: 'success', text: T('verdict.plain') });
    } else if (top.score >= 70 && (!second || top.score - second.score >= 10)) {
      out.push({
        type: 'note',
        level: 'success',
        text: T('verdict.top', { name: top.name, score: top.score }),
      });
    } else if (top.score >= 45) {
      out.push({
        type: 'note',
        level: 'info',
        text: second
          ? T('verdict.close', {
              first: top.name,
              a: top.score,
              second: second.name,
              b: second.score,
            })
          : T('verdict.top', { name: top.name, score: top.score }),
      });
    } else {
      out.push({ type: 'note', level: 'warn', text: T('verdict.weak', { name: top.name }) });
    }

    if (stats.letters < 50 && stats.letters > 0) {
      out.push({ type: 'note', level: 'warn', text: T('note.short', { count: stats.letters }) });
    }
    if (stats.truncated) out.push({ type: 'note', level: 'info', text: T('note.truncated') });
    out.push({ type: 'note', level: 'info', text: T('note.honest') });

    if (listed.length) {
      out.push({
        type: 'table',
        label: T('label.ranking'),
        columns: ['#', T('col.family'), T('col.fit')],
        rows: listed.map((c, i) => [i + 1, c.name, `${c.score} %`]),
        highlight: [0],
      });
      for (const [i, c] of listed.slice(0, DETAILED).entries()) {
        if (c.why.length || c.against.length) out.push(reasonsBlock(c, i + 1));
        if (c.links.length) out.push(openBlock(c, text, i === 0));
      }
    }
    const frequency = byId.get('frequency');
    if (frequency && stats.letters >= 20) {
      out.push({
        type: 'actions',
        label: T('label.more'),
        actions: [
          {
            label: T('open', { tool: toolName(frequency) }),
            options: {},
            open: { tool: 'frequency', text },
          },
        ],
      });
    }
    out.push(
      statisticsTable(stats),
      checksTable(stats),
      ...periodTable(stats),
      ...kasiskiTable(stats),
    );
    return out;
  },
});
