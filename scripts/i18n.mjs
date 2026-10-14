// i18n maintenance. Usage:
//   node scripts/i18n.mjs extract   copy tool/category English text from the code into en.json
//   node scripts/i18n.mjs check     fail on any gap between locales (CI runs this)
//   node scripts/i18n.mjs check --prefix=tool.base64.   only report keys under a prefix
//   node scripts/i18n.mjs add frag.json   merge { en: {...}, fr: {...}, ... } into the locales
//   node scripts/i18n.mjs missing fr tool.base64.   English text of keys fr still lacks
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createServer } from 'vite';

const ROOT = new URL('..', import.meta.url).pathname;
const DIR = join(ROOT, 'src/i18n/locales');
const LOCALES = ['en', 'fr', 'ru', 'zh', 'hi'];
// French "many" only applies to exact millions; falling back to "other" reads correctly.
const OPTIONAL_FORMS = { fr: ['many'] };
const PLURAL = /_(zero|one|two|few|many|other)$/;
const AUTO =
  /^tool\.[a-z0-9-]+\.(name|description|placeholder|options\..+|examples\..+)$|^cat\.|^sig\./;

const read = (l) => JSON.parse(readFileSync(join(DIR, `${l}.json`), 'utf8'));

/** Serialise writers (several agents or scripts may update the locales at once). */
async function withLock(fn) {
  const lock = join(DIR, '.lock');
  for (let i = 0; ; i++) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      if (i > 600) throw new Error(`Locale lock held for too long: remove ${lock} if stale.`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}
const write = (l, d) => {
  const sorted = Object.fromEntries(
    Object.keys(d)
      .sort()
      .map((k) => [k, d[k]]),
  );
  writeFileSync(join(DIR, `${l}.json`), `${JSON.stringify(sorted, null, 2)}\n`);
};

async function codeDefaults() {
  const vite = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  });
  try {
    const { TOOLS } = await vite.ssrLoadModule('/src/core/registry.ts');
    const tt = await vite.ssrLoadModule('/src/i18n/tool-text.ts');
    const { SIGNATURES } = await vite.ssrLoadModule('/src/lib/signatures.ts');
    const out = { ...tt.categoryDefaultStrings(), ...tt.signatureDefaultStrings(SIGNATURES) };
    for (const tool of TOOLS) Object.assign(out, tt.toolDefaultStrings(tool));
    return out;
  } finally {
    await vite.close();
  }
}

/** Group "key_one"/"key_other" under "key"; plain keys map to themselves. */
function bases(dict) {
  const map = new Map();
  for (const k of Object.keys(dict)) {
    const m = k.match(PLURAL);
    const base = m && `${k.replace(PLURAL, '')}_other` in dict ? k.replace(PLURAL, '') : k;
    const forms = map.get(base) ?? new Set();
    if (base !== k) forms.add(m[1]);
    map.set(base, forms);
  }
  return map;
}

const placeholders = (s) =>
  [...s.matchAll(/\{(\w+)\}/g)]
    .map((m) => m[1])
    .sort()
    .join(',');

function* sourceFiles(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* sourceFiles(p);
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) yield p;
  }
}

/** Literal keys used in code: t('a.b'), plus T('x') where const T = toolT('id'). */
function usedKeys() {
  const used = new Map();
  for (const file of sourceFiles(join(ROOT, 'src'))) {
    const src = readFileSync(file, 'utf8');
    const rel = relative(ROOT, file);
    for (const m of src.matchAll(/\bt\(\s*'([a-zA-Z0-9_.-]+)'/g)) used.set(m[1], rel);
    for (const a of src.matchAll(/const (\w+) = toolT\('([a-z0-9-]+)'\)/g)) {
      const re = new RegExp(`\\b${a[1]}\\(\\s*'([a-zA-Z0-9_.-]+)'`, 'g');
      for (const m of src.matchAll(re)) used.set(`tool.${a[2]}.${m[1]}`, rel);
    }
  }
  return used;
}

async function extract() {
  const defaults = await codeDefaults();
  await withLock(() => extractInto(defaults));
}

function extractInto(defaults) {
  const en = read('en');
  let added = 0;
  let changed = 0;
  let removed = 0;
  for (const k of Object.keys(en)) {
    if (AUTO.test(k) && !(k in defaults)) {
      delete en[k];
      removed++;
    }
  }
  for (const [k, v] of Object.entries(defaults)) {
    if (!(k in en)) added++;
    else if (en[k] !== v) changed++;
    en[k] = v;
  }
  write('en', en);
  for (const l of LOCALES.slice(1)) write(l, read(l)); // keep key order identical everywhere
  console.log(`en.json: ${added} added, ${changed} updated, ${removed} removed.`);
  if (changed) console.log('Updated English text: re-check those keys in the other locales.');
}

async function check(prefix) {
  const problems = [];
  const warnings = [];
  const en = read('en');
  const enBases = bases(en);
  const { terms: glossary, exempt = {} } = JSON.parse(
    readFileSync(join(ROOT, 'src/i18n/glossary.json'), 'utf8'),
  );
  const termRe = (term) =>
    new RegExp(
      // Whole word, case-insensitive; a plural "s" is fine ("flags").
      `(^|[^\\p{L}\\p{N}])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}s?($|[^\\p{L}\\p{N}])`,
      /[A-Z]/.test(term) ? 'u' : 'iu', // proper names (Whitespace, Strings) are case-sensitive
    );

  const defaults = await codeDefaults();
  for (const [k, v] of Object.entries(defaults)) {
    if (!(k in en)) problems.push(`en: missing "${k}" — run npm run i18n:extract`);
    else if (en[k] !== v)
      problems.push(`en: "${k}" differs from the code — run npm run i18n:extract`);
  }
  for (const [k, file] of usedKeys()) {
    if (!enBases.has(k) && !(k in en)) problems.push(`${file}: key "${k}" is not in en.json`);
  }

  for (const l of LOCALES.slice(1)) {
    const d = read(l);
    const dBases = bases(d);
    const cats = new Intl.PluralRules(l).resolvedOptions().pluralCategories;
    const required = cats.filter((c) => !(OPTIONAL_FORMS[l] ?? []).includes(c));
    for (const [base, enForms] of enBases) {
      const enText = enForms.size
        ? Object.entries(en)
            .filter(([k]) => k.startsWith(`${base}_`))
            .map(([, v]) => v)
        : [en[base]];
      if (!enForms.size) {
        if (!(base in d)) {
          problems.push(`${l}: missing "${base}"`);
          continue;
        }
      } else {
        for (const c of required) {
          if (!(`${base}_${c}` in d)) problems.push(`${l}: missing plural form "${base}_${c}"`);
        }
      }
      const forms = enForms.size
        ? Object.keys(d).filter((k) => k.replace(PLURAL, '') === base && PLURAL.test(k))
        : [base];
      const expectedPh = placeholders(enText.join(' '));
      for (const k of forms) {
        const v = d[k];
        if (typeof v !== 'string' || !v.trim()) {
          problems.push(`${l}: "${k}" is empty`);
          continue;
        }
        const ph = placeholders(v);
        // A plural form may drop {count} (e.g. "Flag candidate" for one) but never invent one.
        const allowed = new Set(expectedPh.split(',').filter(Boolean));
        for (const p of ph.split(',').filter(Boolean)) {
          if (!allowed.has(p))
            problems.push(`${l}: "${k}" uses {${p}}, which English does not have`);
        }
        if (!enForms.size && ph !== expectedPh)
          problems.push(`${l}: "${k}" placeholders {${ph}} ≠ English {${expectedPh}}`);
        for (const term of glossary) {
          if ((exempt[base] ?? []).includes(term)) continue; // the English uses it as a plain word
          if (enText.some((s) => termRe(term).test(s)) && !termRe(term).test(v)) {
            problems.push(`${l}: "${k}" must keep the term "${term}" unchanged`);
          }
        }
        if (v === enText[0] && /[a-z]{3,}\s+[a-z]{3,}\s+[a-z]{3,}/i.test(v)) {
          warnings.push(`${l}: "${k}" is identical to English`);
        }
      }
    }
    for (const base of dBases.keys()) {
      if (!enBases.has(base))
        problems.push(`${l}: "${base}" does not exist in en.json (stale key)`);
    }
  }
  if (prefix) {
    // Scoped run (one tool while others are still being translated).
    const keep = (p) => p.includes(`"${prefix}`) || p.includes(` ${prefix}`);
    problems.splice(0, problems.length, ...problems.filter(keep));
    warnings.splice(0, warnings.length, ...warnings.filter(keep));
  }
  for (const w of warnings.slice(0, 20)) console.warn(`warning: ${w}`);
  if (warnings.length > 20) console.warn(`… ${warnings.length - 20} more warnings`);
  if (problems.length) {
    console.error(`i18n check failed (${problems.length}):\n${problems.slice(0, 200).join('\n')}`);
    if (problems.length > 200) console.error(`… ${problems.length - 200} more`);
    process.exit(1);
  }
  console.log(`i18n check: ${enBases.size} keys × ${LOCALES.length} locales consistent.`);
}

/** Merge a fragment { en: {...}, fr: {...}, ... } into the locale files (under the lock). */
async function add(file) {
  const frag = JSON.parse(readFileSync(file, 'utf8'));
  const unknown = Object.keys(frag).filter((l) => !LOCALES.includes(l));
  if (unknown.length) throw new Error(`Unknown locale(s) in ${file}: ${unknown.join(', ')}`);
  await withLock(() => {
    for (const l of LOCALES) {
      if (!frag[l]) continue;
      const d = read(l);
      for (const [k, v] of Object.entries(frag[l])) {
        if (typeof v !== 'string') throw new Error(`${l}: "${k}" must be a string`);
        d[k] = v;
      }
      write(l, d);
    }
  });
  console.log(
    `Merged ${file}: ${LOCALES.map((l) => `${l} ${Object.keys(frag[l] ?? {}).length}`).join(', ')}`,
  );
}

/** Print the English text of keys a locale lacks (optionally under a prefix), as JSON. */
function missing(locale, prefix = '') {
  const en = read('en');
  const d = read(locale);
  const cats = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
  const out = {};
  for (const [base, forms] of bases(en)) {
    if (!base.startsWith(prefix)) continue;
    if (!forms.size) {
      if (!(base in d)) out[base] = en[base];
      continue;
    }
    for (const c of cats) {
      if ((OPTIONAL_FORMS[locale] ?? []).includes(c)) continue;
      const k = `${base}_${c}`;
      if (!(k in d)) out[k] = en[k] ?? en[`${base}_other`];
    }
  }
  console.log(JSON.stringify(out, null, 2));
}

const cmd = process.argv[2];
if (cmd === 'extract') await extract();
else if (cmd === 'check')
  await check(process.argv.find((a) => a.startsWith('--prefix='))?.slice(9));
else if (cmd === 'add') await add(process.argv[3]);
else if (cmd === 'missing') missing(process.argv[3], process.argv[4] ?? '');
else {
  console.error(
    'usage: node scripts/i18n.mjs extract | check [--prefix=…] | add <frag.json> | missing <locale> [prefix]',
  );
  process.exit(2);
}
