// Builds src/tools/stego/_unicode-data.ts, the Unicode 16.0.0 data of the "Hidden Unicode text"
// tool (names, general categories, blocks, confusables).
//
//   node scripts/gen-unicode-data.mjs
//   node scripts/gen-unicode-data.mjs --confusables=PATH --unicode-data=PATH --blocks=PATH
//
// Every file is read from the path given, or else downloaded: the canonical unicode.org URL
// first, the official unicode-org mirror when that fails. Behind an HTTP proxy, run it with
// NODE_USE_ENV_PROXY=1 so that Node's fetch honours HTTPS_PROXY. The raw files are never written
// to the repository, only the generated TypeScript is. The output is deterministic: the same
// input files give the same bytes.
//
// What is kept (see the header written into the generated file):
//   BLOCKS         every block of Blocks.txt
//   CATEGORY_RUNS  the general category of every code point (run-length encoded)
//   RANGES         the First/Last ranges of UnicodeData.txt (CJK, Hangul, Tangut, private use)
//   NAMES          the character names of a useful subset (see KEEP_BLOCKS and KEEP_CATEGORIES),
//                  minus the names that src/tools/stego/_unicode-lookup.ts computes by itself
//                  (that code is checked here against the real names)
//   CONFUSABLES    the confusables.txt entries (type MA) whose target is ASCII, from a non-ASCII
//                  character, and the ASCII entries that fix the skeleton of the ASCII letters
//   COMPAT         fullwidth / mathematical / circled / squared forms of an ASCII letter or
//                  digit, from the compatibility decompositions of UnicodeData.txt
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { format, resolveConfig } from 'prettier';
import { createServer } from 'vite';

const VERSION = '16.0.0';
const OUT = fileURLToPath(new URL('../src/tools/stego/_unicode-data.ts', import.meta.url));
const MIRROR = 'https://raw.githubusercontent.com/unicode-org/unicodetools/main/unicodetools/data';
const FILES = {
  confusables: {
    flag: 'confusables',
    canonical: `https://www.unicode.org/Public/security/${VERSION}/confusables.txt`,
    mirror: `${MIRROR}/security/${VERSION}/confusables.txt`,
  },
  unicodeData: {
    flag: 'unicode-data',
    canonical: `https://www.unicode.org/Public/${VERSION}/ucd/UnicodeData.txt`,
    mirror: `${MIRROR}/ucd/${VERSION}/UnicodeData.txt`,
  },
  blocks: {
    flag: 'blocks',
    canonical: `https://www.unicode.org/Public/${VERSION}/ucd/Blocks.txt`,
    mirror: `${MIRROR}/ucd/${VERSION}/Blocks.txt`,
  },
};

// Blocks whose characters all get a bundled name (plus every confusable source and every
// character of KEEP_CATEGORIES, wherever they are). Chosen for what turns up in hidden-text and
// lookalike puzzles; everything else shows "name not bundled" with its block and category.
const KEEP_BLOCKS = new Set([
  'Basic Latin',
  'Latin-1 Supplement',
  'Latin Extended-A',
  'Latin Extended-B',
  'IPA Extensions',
  'Spacing Modifier Letters',
  'Combining Diacritical Marks',
  'Greek and Coptic',
  'Cyrillic',
  'Cyrillic Supplement',
  'Armenian',
  'Hebrew',
  'Arabic',
  'Devanagari',
  'Thai',
  'Georgian',
  'Hangul Jamo',
  'Cherokee',
  'Phonetic Extensions',
  'Phonetic Extensions Supplement',
  'Combining Diacritical Marks Supplement',
  'Latin Extended Additional',
  'Greek Extended',
  'General Punctuation',
  'Superscripts and Subscripts',
  'Currency Symbols',
  'Combining Diacritical Marks for Symbols',
  'Letterlike Symbols',
  'Number Forms',
  'Arrows',
  'Mathematical Operators',
  'Miscellaneous Technical',
  'Control Pictures',
  'Enclosed Alphanumerics',
  'Box Drawing',
  'Block Elements',
  'Geometric Shapes',
  'Miscellaneous Symbols',
  'Dingbats',
  'Braille Patterns',
  'Latin Extended-C',
  'Coptic',
  'CJK Symbols and Punctuation',
  'Hiragana',
  'Katakana',
  'Cyrillic Extended-A',
  'Latin Extended-D',
  'Cyrillic Extended-B',
  'Cyrillic Extended-C',
  'Latin Extended-E',
  'Cherokee Supplement',
  'Alphabetic Presentation Forms',
  'Variation Selectors',
  'Halfwidth and Fullwidth Forms',
  'Specials',
  'Mathematical Alphanumeric Symbols',
  'Enclosed Alphanumeric Supplement',
  'Emoticons',
  'Miscellaneous Symbols and Pictographs',
  'Transport and Map Symbols',
  'Supplemental Symbols and Pictographs',
  'Tags',
  'Variation Selectors Supplement',
]);
const KEEP_CATEGORIES = new Set(['Cc', 'Cf', 'Zs', 'Zl', 'Zp', 'Mn', 'Me']);
// Compatibility forms kept as lookalikes of an ASCII letter or digit (both conditions needed).
// The letterlike symbols (the double-struck R of the reals, the Kelvin sign) are left out: they
// are mathematics and units, not disguised letters. The circled and squared forms are kept for
// letters only: the circled numbers are list markers.
const COMPAT_BLOCKS = new Set([
  'Halfwidth and Fullwidth Forms',
  'Mathematical Alphanumeric Symbols',
  'Enclosed Alphanumerics',
  'Enclosed Alphanumeric Supplement',
]);
const COMPAT_LETTERS_ONLY = new Set(['Enclosed Alphanumerics', 'Enclosed Alphanumeric Supplement']);
const COMPAT_TAGS = new Set(['<font>', '<wide>', '<circle>', '<square>']);

const LICENSE = `UNICODE LICENSE V3

COPYRIGHT AND PERMISSION NOTICE

Copyright © 2001-2024 Unicode, Inc.

NOTICE TO USER: Carefully read the following legal agreement. BY
DOWNLOADING, INSTALLING, COPYING OR OTHERWISE USING DATA FILES, AND/OR
SOFTWARE, YOU UNEQUIVOCALLY ACCEPT, AND AGREE TO BE BOUND BY, ALL OF THE
TERMS AND CONDITIONS OF THIS AGREEMENT. IF YOU DO NOT AGREE, DO NOT
DOWNLOAD, INSTALL, COPY, DISTRIBUTE OR USE THE DATA FILES OR SOFTWARE.

Permission is hereby granted, free of charge, to any person obtaining a
copy of data files and any associated documentation (the "Data Files") or
software and any associated documentation (the "Software") to deal in the
Data Files or Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, and/or sell
copies of the Data Files or Software, and to permit persons to whom the
Data Files or Software are furnished to do so, provided that either (a)
this copyright and permission notice appear with all copies of the Data
Files or Software, or (b) this copyright and permission notice appear in
associated Documentation.

THE DATA FILES AND SOFTWARE ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF
THIRD PARTY RIGHTS.

IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS INCLUDED IN THIS NOTICE
BE LIABLE FOR ANY CLAIM, OR ANY SPECIAL INDIRECT OR CONSEQUENTIAL DAMAGES,
OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THE DATA
FILES OR SOFTWARE.

Except as contained in this notice, the name of a copyright holder shall
not be used in advertising or otherwise to promote the sale, use or other
dealings in these Data Files or Software without prior written
authorization of the copyright holder.`;

// ---------- input ----------

function argOf(name) {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

async function load({ flag, canonical, mirror }) {
  const local = argOf(flag);
  if (local) return readFileSync(local, 'utf8').replace(/^\uFEFF/, '');
  const failures = [];
  for (const url of [canonical, mirror]) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (res.ok) return (await res.text()).replace(/^\uFEFF/, '');
      failures.push(`${url}: HTTP ${res.status}`);
    } catch (e) {
      failures.push(`${url}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(
    `Cannot download ${canonical}:\n  ${failures.join('\n  ')}\n` +
      `Download the file yourself and pass it with --${flag}=PATH (behind a proxy, also try NODE_USE_ENV_PROXY=1).`,
  );
}

const dataLines = (text) => text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
const hex = (n) => n.toString(16).toUpperCase();
const ascii = (cps) => cps.every((c) => c >= 0x20 && c < 0x7f);

// ---------- parsing ----------

function parseBlocks(text) {
  if (!text.includes(`Blocks-${VERSION}.txt`)) throw new Error(`Blocks.txt is not ${VERSION}`);
  return dataLines(text).map((line) => {
    const m = /^([0-9A-F]+)\.\.([0-9A-F]+); (.+)$/.exec(line);
    if (!m) throw new Error(`Blocks.txt: cannot read "${line}"`);
    return { first: parseInt(m[1], 16), last: parseInt(m[2], 16), name: m[3].trim() };
  });
}

function parseUnicodeData(text) {
  const chars = [];
  const ranges = [];
  let open = null;
  for (const line of dataLines(text)) {
    const f = line.split(';');
    const cp = parseInt(f[0], 16);
    const first = /^<(.+), First>$/.exec(f[1]);
    const last = /^<(.+), Last>$/.exec(f[1]);
    if (first) open = { first: cp, label: first[1], category: f[2] };
    else if (last && open?.label === last[1]) {
      ranges.push({ ...open, last: cp });
      open = null;
    } else {
      chars.push({
        cp,
        name: f[1],
        category: f[2],
        decomposition: f[5],
        oldName: f[10],
      });
    }
  }
  if (!chars.some((c) => c.cp === 0x41 && c.name === 'LATIN CAPITAL LETTER A')) {
    throw new Error('UnicodeData.txt looks wrong: U+0041 is missing');
  }
  return { chars, ranges };
}

function parseConfusables(text) {
  if (!new RegExp(`# Version: ${VERSION.replace(/\./g, '\\.')}`).test(text)) {
    throw new Error(`confusables.txt is not ${VERSION}`);
  }
  return dataLines(text).map((line) => {
    const [source, target, type] = line
      .split('#')[0]
      .split(';')
      .map((s) => s.trim());
    return {
      source: parseInt(source, 16),
      target: target.split(/\s+/).map((h) => parseInt(h, 16)),
      type,
    };
  });
}

// ---------- building ----------

/** Name shown for a control character: the Unicode 1 name without its "(LF)" abbreviation. */
function controlName(c) {
  const old = c.oldName.replace(/\s*\([A-Z0-9 ]+\)$/, '').trim();
  return old || `<control-${hex(c.cp).padStart(4, '0')}>`;
}

function categoryRuns(chars, ranges) {
  const cats = new Map(chars.map((c) => [c.cp, c.category]));
  for (const r of ranges) for (let cp = r.first; cp <= r.last; cp++) cats.set(cp, r.category);
  const runs = [];
  let current = null;
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    const cat = cats.get(cp) ?? 'Cn';
    if (cat !== current) {
      runs.push(`${hex(cp)}${cat}`);
      current = cat;
    }
  }
  return runs.join(' ');
}

/** The names as "@HEX" jumps and one name per line for the code points that follow. */
function namesTable(entries) {
  const lines = [];
  let next = -1;
  for (const [cp, name] of entries) {
    if (cp !== next) lines.push(`@${hex(cp)}`);
    lines.push(name);
    next = cp + 1;
  }
  return lines.join('\n');
}

async function build() {
  const [confText, udText, blocksText] = await Promise.all([
    load(FILES.confusables),
    load(FILES.unicodeData),
    load(FILES.blocks),
  ]);
  const blocks = parseBlocks(blocksText);
  const { chars, ranges } = parseUnicodeData(udText);
  const confusables = parseConfusables(confText);
  const blockOf = (cp) => blocks.find((b) => cp >= b.first && cp <= b.last)?.name ?? 'No_Block';
  for (const name of [...KEEP_BLOCKS, ...COMPAT_BLOCKS]) {
    if (!blocks.some((b) => b.name === name)) throw new Error(`No block called "${name}"`);
  }

  // The names that the lookup code computes itself must come out exactly as in the data.
  const vite = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  });
  let algorithmic;
  try {
    ({ algorithmicName: algorithmic } = await vite.ssrLoadModule(
      '/src/tools/stego/_unicode-lookup.ts',
    ));
  } finally {
    await vite.close();
  }
  const realNames = new Map(
    chars.map((c) => [c.cp, c.category === 'Cc' ? controlName(c) : c.name]),
  );
  const categories = new Map(chars.map((c) => [c.cp, c.category]));
  for (const r of ranges) for (let cp = r.first; cp <= r.last; cp++) categories.set(cp, r.category);
  const rangeOf = (cp) => ranges.find((r) => cp >= r.first && cp <= r.last)?.label ?? null;
  const ctx = {
    name: (cp) => realNames.get(cp) ?? null,
    category: (cp) => categories.get(cp) ?? 'Cn',
    range: rangeOf,
  };

  // Confusable sources: every one of them gets a name, as does anything in a kept block.
  const sources = new Set(confusables.map((c) => c.source));
  const kept = [];
  let computed = 0;
  for (const c of chars) {
    const wanted =
      sources.has(c.cp) || KEEP_CATEGORIES.has(c.category) || KEEP_BLOCKS.has(blockOf(c.cp));
    if (!wanted) continue;
    const name = c.category === 'Cc' ? controlName(c) : c.name;
    const own = algorithmic(c.cp, ctx);
    if (own !== null) {
      if (own !== name) throw new Error(`U+${hex(c.cp)}: computed "${own}", real "${name}"`);
      computed++;
      continue;
    }
    kept.push([c.cp, name]);
  }
  // Ranges are named by code, too: check the shape of every label we rely on.
  for (const r of ranges) {
    const sample = algorithmic(r.first, ctx);
    const known = /^(CJK Ideograph|Tangut Ideograph|Hangul Syllable)/.test(r.label);
    if (known !== (sample !== null)) throw new Error(`Range "${r.label}" is not handled`);
  }

  // Skeleton data: type MA only, non-ASCII sources with an ASCII target, and the ASCII sources.
  if (confusables.some((c) => c.type !== 'MA')) throw new Error('confusables.txt: unexpected type');
  const toAscii = confusables.filter((c) => ascii(c.target));
  const fromNonAscii = toAscii.filter((c) => c.source >= 0x80);
  const fromAscii = toAscii.filter((c) => c.source < 0x80);
  const text = (cps) => String.fromCodePoint(...cps);

  const compat = [];
  for (const c of chars) {
    const m = /^(<\w+>) ([0-9A-F]{4})$/.exec(c.decomposition);
    if (!m || !COMPAT_TAGS.has(m[1]) || !COMPAT_BLOCKS.has(blockOf(c.cp))) continue;
    const target = String.fromCharCode(parseInt(m[2], 16));
    const pattern = COMPAT_LETTERS_ONLY.has(blockOf(c.cp)) ? /[A-Za-z]/ : /[0-9A-Za-z]/;
    if (pattern.test(target)) compat.push([c.cp, target]);
  }

  const sections = {
    UNICODE_VERSION: VERSION,
    BLOCKS: blocks.map((b) => `${hex(b.first)};${hex(b.last)};${b.name}`).join('\n'),
    CATEGORY_RUNS: categoryRuns(chars, ranges),
    RANGES: ranges.map((r) => `${hex(r.first)};${hex(r.last)};${r.label}`).join('\n'),
    NAMES: namesTable(kept),
    CONFUSABLES: fromNonAscii.map((c) => `${hex(c.source)}:${text(c.target)}`).join('\n'),
    ASCII_SKELETON: fromAscii.map((c) => `${text([c.source])}:${text(c.target)}`).join('\n'),
    COMPAT: compat.map(([cp, letter]) => `${hex(cp)}:${letter}`).join('\n'),
  };
  const stats = {
    names: kept.length,
    computed,
    confusables: fromNonAscii.length,
    asciiSkeleton: fromAscii.length,
    compat: compat.length,
    blocks: blocks.length,
    ranges: ranges.length,
  };
  return { sections, stats };
}

function render({ sections }) {
  const licence = LICENSE.split('\n')
    .map((l) => (l ? ` * ${l}` : ' *'))
    .join('\n');
  const body = Object.entries(sections)
    .map(([name, value]) => `export const ${name} = ${JSON.stringify(value)};`)
    .join('\n\n');
  return `/**
 * GENERATED by scripts/gen-unicode-data.mjs, do not edit.
 *
 * Unicode ${VERSION} data, taken from the Unicode Character Database and from the Unicode
 * Security Mechanisms (UTS #39) files:
 *   ${FILES.confusables.canonical}
 *   ${FILES.unicodeData.canonical}
 *   ${FILES.blocks.canonical}
 * (the same files are in the official unicode-org mirror:
 *   ${MIRROR}/)
 *
 * What is in here:
 *   BLOCKS         the code point ranges and names of all the blocks (Blocks.txt)
 *   CATEGORY_RUNS  the general category of every code point, run-length encoded (UnicodeData.txt)
 *   RANGES         the First/Last ranges of UnicodeData.txt (CJK ideographs, Hangul, private use)
 *   NAMES          the names of a subset of the characters (UnicodeData.txt): the confusable
 *                  sources, every Cc Cf Zs Zl Zp Mn Me character, and the Latin, Greek, Cyrillic,
 *                  Armenian, Cherokee, IPA, punctuation, symbol, fullwidth, mathematical and
 *                  emoji blocks. The names of the ranges and of the tag, variation selector and
 *                  CJK compatibility characters are computed by _unicode-lookup.ts
 *   CONFUSABLES    confusables.txt, type MA, from a non-ASCII character to an ASCII skeleton
 *   ASCII_SKELETON confusables.txt entries whose source is ASCII (they fix the skeleton of I, l, 0, m)
 *   COMPAT         the fullwidth, mathematical, circled and squared forms of an ASCII letter or
 *                  digit (compatibility decompositions of UnicodeData.txt)
 *
 * Formats are described next to the parser in _unicode-lookup.ts.
 *
 * The data files are distributed under the Unicode License v3, whose notice must come with every
 * substantial portion of them:
 *
${licence}
 */

${body}
`;
}

const built = await build();
const source = render(built);
const options = { ...(await resolveConfig(OUT)), filepath: OUT };
const formatted = await format(source, options);
writeFileSync(OUT, formatted);

const gz = (s) => gzipSync(Buffer.from(s, 'utf8'), { level: 9 }).length;
console.log(`Unicode ${VERSION} data written to src/tools/stego/_unicode-data.ts`);
console.log(JSON.stringify(built.stats));
for (const [name, value] of Object.entries(built.sections)) {
  console.log(`  ${name.padEnd(14)} ${String(value.length).padStart(8)} B   gzip ${gz(value)} B`);
}
console.log(
  `  file           ${String(Buffer.byteLength(formatted)).padStart(8)} B   gzip ${gz(formatted)} B`,
);
