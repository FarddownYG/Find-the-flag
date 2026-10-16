import { TOOLS } from '../core/registry';
import type { AnyTool } from '../core/types';
import { toolDescription, toolName } from '../i18n/tool-text';

/**
 * Sidebar search. Words are compared lowercase, without the accents of Latin letters ("décimal"
 * finds "decimal" and the other way round), and "base 8", "base-8" and "base8" are one word.
 */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/(\p{Script=Latin})[̀-ͯ]+/gu, '$1')
    .normalize('NFC')
    .replace(/\bbase[\s_-]*(\d+)/g, 'base$1');
}

const BASE_WORD = /^base(\d+)$/;

/**
 * Does `text` mention base N exactly? "base8" is in "base 8" and "Base8 / Octal" but not in
 * "Base85", and "base10" is not in "Base100": a digit after "base" is the whole number.
 */
const mentionsBase = (text: string, n: string): boolean =>
  new RegExp(`(?:^|[^a-z0-9])base${n}(?![0-9])`).test(text);

/** Rank a tool for one word: exact names/aliases first, then prefixes, then any mention. */
export function matchScore(tool: AnyTool, word: string): number {
  const w = normalize(word);
  // Both the English name and the translated one match, so aliases keep working in any language.
  const names = [tool.name, toolName(tool)].map(normalize);
  const tags = (tool.tags ?? []).map(normalize);
  const desc = normalize(`${tool.description} ${toolDescription(tool)}`);
  if (tool.id === w || names.includes(w) || tags.includes(w)) return 100;

  const base = BASE_WORD.exec(w)?.[1];
  if (base !== undefined) {
    // No prefix match here: "base8" must not bring up Base85, nor "base1" Base100.
    if (names.some((n) => mentionsBase(n, base))) return 60;
    if (tags.some((x) => mentionsBase(x, base))) return 50;
    return mentionsBase(desc, base) ? 20 : 0;
  }

  if (names.some((n) => n.startsWith(w)) || tool.id.startsWith(w)) return 80;
  if (tags.some((x) => x.startsWith(w))) return 70;
  if (names.some((n) => n.includes(w))) return 60;
  if (tags.some((x) => x.includes(w))) return 50;
  if (desc.includes(w)) return 20;
  return 0;
}

/** The tools matching every word of the query, best first (all of them for an empty query). */
export function search(q: string, tools: readonly AnyTool[] = TOOLS): AnyTool[] {
  const words = normalize(q).split(/\s+/).filter(Boolean);
  if (!words.length) return [...tools];
  return tools
    .map((t, i) => {
      const scores = words.map((w) => matchScore(t, w));
      return { t, i, score: Math.min(...scores) && scores.reduce((a, b) => a + b, 0) };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((r) => r.t);
}
