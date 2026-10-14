/**
 * Flag spotting: every text the shell renders is scanned with these patterns,
 * and matches are highlighted + collected in the "flag candidates" strip.
 */

/** prefix{...} — covers flag{}, CTF{}, picoCTF{}, HTB{}, RM{}, FLAG{}... */
export const DEFAULT_FLAG_PATTERN = String.raw`[A-Za-z][A-Za-z0-9_\-]{1,24}\{[^{}\s]{2,200}\}`;

/** The default alternative is a named group, so findFlags knows when the user's pattern matched. */
const DEFAULT_GROUP = `(?<ftfdefault>${DEFAULT_FLAG_PATTERN})`;

export function buildFlagRegex(custom?: string): RegExp {
  const parts = [DEFAULT_GROUP];
  if (custom?.trim()) parts.unshift(`(?:${custom.trim()})`);
  try {
    return new RegExp(parts.join('|'), 'g');
  } catch {
    return new RegExp(DEFAULT_GROUP, 'g');
  }
}

export interface FlagSpan {
  start: number;
  end: number;
  value: string;
}

export function findFlags(text: string, re: RegExp, limit = 50): FlagSpan[] {
  const out: FlagSpan[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && out.length < limit) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    // A match of the user's own pattern is kept as it is; a default one loses glued characters.
    const byUser = m.groups !== undefined && m.groups.ftfdefault === undefined;
    const skip = byUser ? 0 : gluedPrefixLength(m[0]);
    out.push({ start: m.index + skip, end: m.index + m[0].length, value: m[0].slice(skip) });
  }
  return out;
}

export const KNOWN_PREFIX = /^(flag|ctf|[a-z0-9]*ctf|htb|thm|key|secret)\{/i;

/**
 * Characters glued in front of a "flag{" prefix ("Fflag{…}" when a random printable byte
 * precedes the flag in a binary): their count, or 0. Only "flag" is trimmed: "monkey{…}" or
 * "picoCTF{…}" are formats of their own.
 */
export function gluedPrefixLength(value: string): number {
  if (KNOWN_PREFIX.test(value)) return 0;
  const brace = value.indexOf('{');
  const m = brace > 0 ? /flag$/i.exec(value.slice(0, brace)) : null;
  return m ? m.index : 0;
}

/**
 * Which candidates deserve the highlight. Brute-force outputs contain dozens of
 * prefix{...} lookalikes, so: known prefixes (or the user's own pattern) win; otherwise
 * generic matches are kept only when there are few of them.
 */
export function selectFlags(text: string, re: RegExp, custom?: string): Set<string> {
  const all = [...new Set(findFlags(text, re, 500).map((f) => f.value))];
  let customRe: RegExp | null = null;
  try {
    customRe = custom?.trim() ? new RegExp(`^(?:${custom.trim()})$`) : null;
  } catch {
    customRe = null;
  }
  const strong = all.filter((v) => KNOWN_PREFIX.test(v) || customRe?.test(v));
  if (strong.length) return new Set(strong);
  return new Set(all.length <= 3 ? all : []);
}
