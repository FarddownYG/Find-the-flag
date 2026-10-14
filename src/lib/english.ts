/**
 * "Does this look like plaintext?" scoring, shared by every brute-forcer
 * (Caesar, XOR, Vigenère, auto-decode). Higher is better; comparable across candidates.
 */

// English letter frequencies (a..z), percent.
const FREQ = [
  8.2, 1.5, 2.8, 4.3, 12.7, 2.2, 2.0, 6.1, 7.0, 0.15, 0.77, 4.0, 2.4, 6.7, 7.5, 1.9, 0.095, 6.0,
  6.3, 9.1, 2.8, 0.98, 2.4, 0.15, 2.0, 0.074,
];

const COMMON = [' the ', ' and ', ' of ', ' to ', 'ing', ' is ', 'flag', 'ctf', 'the', 'tion'];

/** Chi-squared distance of letter counts to English (lower = more English). */
export function chiSquared(text: string): number {
  const counts = new Array<number>(26).fill(0);
  let total = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i) | 0x20;
    if (c >= 97 && c <= 122) {
      counts[c - 97]!++;
      total++;
    }
  }
  if (total === 0) return Infinity;
  let chi = 0;
  for (let i = 0; i < 26; i++) {
    const expected = (FREQ[i]! / 100) * total;
    chi += (counts[i]! - expected) ** 2 / expected;
  }
  return chi;
}

/** Index of coincidence of the letters (English ≈ 0.066, random ≈ 0.038). */
export function indexOfCoincidence(text: string): number {
  const counts = new Array<number>(26).fill(0);
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i) | 0x20;
    if (c >= 97 && c <= 122) {
      counts[c - 97]!++;
      n++;
    }
  }
  if (n < 2) return 0;
  return counts.reduce((a, k) => a + k * (k - 1), 0) / (n * (n - 1));
}

/**
 * Plaintext score in roughly [0, 100]. Combines printable ratio, letter/space share,
 * English letter distribution and a bonus for common words or a flag-looking token.
 */
export function plaintextScore(text: string): number {
  if (!text.length) return 0;
  let printable = 0;
  let letters = 0;
  let spaces = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c >= 0x20 && c < 0x7f) || c === 9 || c === 10 || c === 13) printable++;
    if ((c | 0x20) >= 97 && (c | 0x20) <= 122) letters++;
    if (c === 0x20) spaces++;
  }
  const pr = printable / text.length;
  if (pr < 0.7) return pr * 20;
  const letterShare = letters / text.length;
  const chi = chiSquared(text);
  const dist = Number.isFinite(chi) ? Math.max(0, 1 - chi / (letters * 3 + 150)) : 0;
  const lower = text.toLowerCase();
  let bonus = 0;
  for (const w of COMMON) if (lower.includes(w)) bonus += 4;
  if (/[a-z0-9_]{2,}\{[^}]+\}/i.test(text)) bonus += 15;
  const spaceShare = spaces / text.length;
  const spaceFit = spaceShare > 0.05 && spaceShare < 0.3 ? 8 : 0;
  return Math.min(100, pr * 40 + letterShare * 20 + dist * 25 + spaceFit + bonus);
}
