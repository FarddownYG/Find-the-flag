/**
 * Tiny client-side i18n. Locale files are static JSON in src/i18n/locales/ (no service, no
 * network). English is bundled as the fallback; other locales load on demand. Works the same in
 * the page and in the tool worker (the runner tells the worker which locale to use).
 *
 * Keys are flat strings: "ui.…" for the shell, "cat.<id>.…" for categories, "tool.<id>.…" for
 * tools. Placeholders: {name}. Plurals: pass {count} and provide "key_one", "key_other" (and
 * "key_few" / "key_many" for Russian), chosen with Intl.PluralRules.
 */
import en from './locales/en.json' with { type: 'json' };

export type Locale = 'en' | 'fr' | 'ru' | 'zh' | 'hi';
type Dict = Record<string, string>;
export type Params = Record<string, string | number>;

/** Endonyms: each language is listed in its own script. */
export const LOCALES: readonly { id: Locale; name: string }[] = [
  { id: 'en', name: 'English' },
  { id: 'fr', name: 'Français' },
  { id: 'ru', name: 'Русский' },
  { id: 'zh', name: '简体中文' },
  { id: 'hi', name: 'हिन्दी' },
];

const EN: Dict = en;
// Explicit dynamic imports (one chunk per language). Unlike import.meta.glob, this module still
// loads in plain Node (Playwright specs import lib code that depends on it).
const loaders: Record<Exclude<Locale, 'en'>, () => Promise<{ default: Dict }>> = {
  fr: () => import('./locales/fr.json'),
  ru: () => import('./locales/ru.json'),
  zh: () => import('./locales/zh.json'),
  hi: () => import('./locales/hi.json'),
};
const STORAGE_KEY = 'ftf.locale';

let current: Locale = 'en';
let dict: Dict = EN;
let plural = new Intl.PluralRules('en');
const listeners = new Set<() => void>();

export const isLocale = (s: string | null | undefined): s is Locale =>
  LOCALES.some((l) => l.id === s);

export function getLocale(): Locale {
  return current;
}

export async function loadLocale(l: Locale): Promise<Dict> {
  if (l === 'en') return EN;
  return (await loaders[l]()).default;
}

/** Switch language (page or worker). Listeners re-render the UI. */
export async function setLocale(l: Locale, opts: { remember?: boolean } = {}): Promise<void> {
  const next = await loadLocale(l);
  current = l;
  dict = next;
  plural = new Intl.PluralRules(l);
  if (opts.remember) {
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      // Storage blocked (private mode): the choice lasts for this tab only.
    }
  }
  if (typeof document !== 'undefined') document.documentElement.lang = l;
  listeners.forEach((fn) => fn());
}

export function onLocaleChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Saved choice, else the first browser language we support, else English. */
export function detectLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isLocale(saved)) return saved;
  } catch {
    // No storage: fall through to the browser languages.
  }
  const langs =
    typeof navigator !== 'undefined' ? (navigator.languages ?? [navigator.language]) : [];
  for (const tag of langs) {
    const base = tag?.toLowerCase().split('-')[0];
    if (isLocale(base)) return base;
  }
  return 'en';
}

function lookup(key: string, count: number | undefined): string | undefined {
  if (count !== undefined) {
    const form = `${key}_${plural.select(count)}`;
    const v =
      dict[form] ??
      dict[`${key}_other`] ??
      EN[`${key}_${new Intl.PluralRules('en').select(count)}`] ??
      EN[`${key}_other`];
    if (v !== undefined) return v;
  }
  return dict[key] ?? EN[key];
}

function interpolate(s: string, params?: Params): string {
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));
}

/** Translate a key. A missing key renders as the key itself, which the checks catch. */
export function t(key: string, params?: Params): string {
  const count = typeof params?.count === 'number' ? params.count : undefined;
  return interpolate(lookup(key, count) ?? key, params);
}

/** Translate a key that has an English fallback written in code (tool declarations). */
export function tOr(key: string, fallback: string, params?: Params): string {
  const count = typeof params?.count === 'number' ? params.count : undefined;
  const v = count !== undefined ? lookup(key, count) : (dict[key] ?? EN[key]);
  return interpolate(v ?? fallback, params);
}

/** Whether a key exists in the active locale or in English. */
export const hasKey = (key: string): boolean => key in dict || key in EN;
