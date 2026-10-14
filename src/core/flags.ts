/**
 * Flag spotting: every text the shell renders is scanned with these patterns,
 * and matches are highlighted + collected in the "flag candidates" strip.
 */

/** prefix{...} — covers flag{}, CTF{}, picoCTF{}, HTB{}, RM{}, FLAG{}... */
export const DEFAULT_FLAG_PATTERN = String.raw`[A-Za-z][A-Za-z0-9_\-]{1,24}\{[^{}\s]{2,200}\}`;

export function buildFlagRegex(custom?: string): RegExp {
  const parts = [DEFAULT_FLAG_PATTERN];
  if (custom?.trim()) parts.unshift(custom.trim());
  try {
    return new RegExp(parts.join('|'), 'g');
  } catch {
    return new RegExp(DEFAULT_FLAG_PATTERN, 'g');
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
    out.push({ start: m.index, end: m.index + m[0].length, value: m[0] });
  }
  return out;
}

const KNOWN_PREFIX = /^(flag|ctf|[a-z0-9]*ctf|htb|thm|key|secret)\{/i;

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
