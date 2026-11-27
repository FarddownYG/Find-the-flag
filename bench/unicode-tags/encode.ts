// Independent Unicode Tags encoder, written from the public spec (Unicode block "Tags", U+E0000..U+E007F):
// every printable ASCII byte 0x20-0x7e maps to the tag character U+E0000 + byte, which renders invisibly.
// The tag run is appended after a visible cover sentence.
export const TAG_BASE = 0xe0000;

export function toTags(secret: string): string {
  let out = '';
  for (const ch of secret) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code > 0x7e) {
      throw new Error(`cannot carry U+${code.toString(16)} in a tag (printable ASCII only)`);
    }
    out += String.fromCodePoint(TAG_BASE + code);
  }
  return out;
}

export function encodeTags(cover: string, secret: string): string {
  return cover + toTags(secret);
}
