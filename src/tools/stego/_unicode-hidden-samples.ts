/**
 * The sample texts of "Hidden Unicode text", made with the tool's own encoders so that the samples
 * and the tool cannot drift apart (scripts/gen-samples-unicode-hidden.mjs writes them to
 * public/samples/, a test checks that the files are up to date). Made-up messages and covers.
 */
import { utf8Encode } from '../../lib/bytes';
import { hideInGlyphs } from './_unicode-hidden-glyph';
import { hideInInvisibles, PAIRS } from './_unicode-hidden-invisible';
import type { UnicodeData } from './_unicode-lookup';

export const SAMPLE_COVERS = {
  zerowidth:
    'Hello team, the quarterly report is attached. Please read it before Friday and send me your comments.',
  homoglyph:
    'The committee will meet on Thursday at noon to discuss the new budget, the schedule of the spring workshop and the list of guests for the final dinner.',
  tags: 'Welcome to the portal. Everything on this page is perfectly ordinary text.',
};

export function buildSamples(data: UnicodeData): Record<string, string> {
  const zerowidth = hideInInvisibles(
    SAMPLE_COVERS.zerowidth,
    'SECRET42',
    PAIRS['zwsp-zwnj']!,
    'after-first',
  );
  const glyph = hideInGlyphs(SAMPLE_COVERS.homoglyph, utf8Encode('HIDDEN_OK'), data);
  if (!glyph.ok) throw new Error('The homoglyph sample cover is too short');
  // Tag characters: ASCII letters as U+E0000 + code, framed by a language tag and a cancel tag.
  const tagged = [...'TAGS_OK'].map((ch) => String.fromCodePoint(0xe0000 + ch.charCodeAt(0)));
  const tags = `${SAMPLE_COVERS.tags}\u{e0001}${tagged.join('')}\u{e007f}`;
  return {
    'unicode-hidden-zerowidth.txt': `${zerowidth.text}\n`,
    'unicode-hidden-homoglyph.txt': `${glyph.text}\n`,
    'unicode-hidden-tags.txt': `${tags}\n`,
  };
}
