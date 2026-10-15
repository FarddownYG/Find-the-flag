/**
 * The sample pictures of "Picture alphabets", drawn by the tool's own symbols so that the samples
 * and the tool cannot drift apart (scripts/gen-samples-symbols.mjs writes them to public/samples/,
 * a test checks that the files are up to date). Challenge-style: the file carries no letters (no
 * title, no data-char), the braces of a flag are plain text, only the inside is in symbols. Made-up
 * messages, no real challenge.
 */
import { ALPHABETS, type AlphabetId } from './_symbols';
import { renderRow } from './_symbols-svg';

export const SAMPLE_TEXTS: Record<string, { alphabet: AlphabetId; text: string; perRow: number }> =
  {
    'symbols-pigpen-flag.svg': { alphabet: 'pigpen', text: 'FTF{PIGPEN}', perRow: 12 },
    'symbols-semaphore-line.svg': { alphabet: 'semaphore', text: 'FTF{FLAGS}', perRow: 12 },
    'symbols-braille-line.svg': { alphabet: 'braille', text: 'ftf{braille}', perRow: 12 },
  };

export function buildSamples(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, { alphabet, text, perRow }] of Object.entries(SAMPLE_TEXTS)) {
    const alpha = ALPHABETS[alphabet];
    const options = { mirror: false };
    out[name] = renderRow(alpha, alpha.tokenize(text, options), {
      perRow,
      labelled: false,
      title: '',
    }).svg;
  }
  return out;
}
