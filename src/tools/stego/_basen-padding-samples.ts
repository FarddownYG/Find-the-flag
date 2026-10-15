/**
 * The sample files of the "hidden bits in base64 / base32 padding" tool, made with the tool's own
 * encoder (`hide`) from made-up messages. scripts/gen-samples-basen-padding.mjs writes them to
 * public/samples/; the tests rebuild them and compare, so the files and the tool cannot drift.
 *
 *   basen-padding-base64.txt  "HIDDEN_OK" in the padding of 18 base64 lines (4 bits each)
 *   basen-padding-base32.txt  "HIDDEN_OK" in the padding of 18 base32 lines (4 bits each)
 *   basen-padding-layers.txt  base64 lines whose padding hides base32 lines, whose padding hides
 *                             "LAYERED_OK" (two layers)
 */
import { utf8Encode } from '../../lib/bytes';
import { type Base, hide } from './_basen-padding';

/** Hide `message` in generated cover lines; the lines are returned as text. */
function hideText(base: Base, message: string): string {
  const res = hide({ base, message: utf8Encode(message), cover: [], repeat: 1 });
  if (!res.ok) throw new Error('a generated cover always has room for its message');
  return res.text;
}

export function buildSamples(): Record<string, string> {
  const inner = hideText('base32', 'LAYERED_OK');
  return {
    'basen-padding-base64.txt': `${hideText('base64', 'HIDDEN_OK')}\n`,
    'basen-padding-base32.txt': `${hideText('base32', 'HIDDEN_OK')}\n`,
    'basen-padding-layers.txt': `${hideText('base64', inner)}\n`,
  };
}
