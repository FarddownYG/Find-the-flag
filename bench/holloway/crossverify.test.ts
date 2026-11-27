import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodeHolloway } from '../../src/tools/stego/_holloway';

/**
 * Cross-verification: the FTF decoder (one author) must recover every secret embedded by the
 * reference encoder (a different author). They share only the protocol table — never each other's
 * code — so a pass proves the Holloway scheme end to end, not a bug both sides copied.
 */
const dir = fileURLToPath(new URL('./corpus/', import.meta.url));
const manifest: { file: string; secret: string; cover: string }[] = JSON.parse(
  readFileSync(new URL('./corpus/manifest.json', import.meta.url), 'utf8'),
);

describe('Holloway — decoder recovers the independent encoder’s secrets', () => {
  for (const entry of manifest) {
    it(`${entry.file} → "${entry.secret}"`, () => {
      const text = readFileSync(dir + entry.file, 'utf8');
      const out = decodeHolloway(text);
      expect(out).not.toBeNull();
      expect(out!.homoglyphs).toBeGreaterThan(0);
      // Trailing zero-padding decodes to spaces; the secret is the leading content.
      expect(out!.message.replace(/ +$/, '')).toBe(entry.secret);
    });
  }
});
