import { latin1Decode } from '../../lib/bytes';

export interface PdfInfoEntry {
  key: string;
  value: string;
  offset: number;
}

const FIELDS = 'Title|Author|Subject|Keywords|Creator|Producer|CreationDate|ModDate|Trapped';
const FIELD_RE = new RegExp(
  String.raw`/(${FIELDS})\s*(\((?:\\[\s\S]|[^\\()])*\)|<[0-9A-Fa-f\s]*>)`,
  'g',
);

function decodeLiteral(raw: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c !== '\\') {
      out.push(raw.charCodeAt(i) & 0xff);
      continue;
    }
    const n = raw[++i];
    if (n === undefined) break;
    const simple: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12 };
    if (n in simple) out.push(simple[n]!);
    else if (/[0-7]/.test(n)) {
      let oct = n;
      while (oct.length < 3 && /[0-7]/.test(raw[i + 1] ?? '')) oct += raw[++i];
      out.push(parseInt(oct, 8) & 0xff);
    } else if (n === '\n' || n === '\r') {
      if (n === '\r' && raw[i + 1] === '\n') i++;
    } else out.push(n.charCodeAt(0) & 0xff);
  }
  return Uint8Array.from(out);
}

function decodeText(b: Uint8Array): string {
  if (b[0] === 0xfe && b[1] === 0xff) {
    let s = '';
    for (let i = 2; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i]! << 8) | b[i + 1]!);
    return s;
  }
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf)
    return new TextDecoder().decode(b.subarray(3));
  return latin1Decode(b);
}

/** Document-information strings (/Title (...), /Author <FEFF...>) found anywhere in the file. */
export function pdfInfoEntries(bytes: Uint8Array): PdfInfoEntry[] {
  const text = latin1Decode(bytes);
  const out: PdfInfoEntry[] = [];
  for (const m of text.matchAll(FIELD_RE)) {
    const token = m[2]!;
    const raw = token.startsWith('(')
      ? decodeLiteral(token.slice(1, -1))
      : Uint8Array.from(
          (token.slice(1, -1).replace(/\s+/g, '').match(/../g) ?? []).map((h) => parseInt(h, 16)),
        );
    out.push({ key: m[1]!, value: decodeText(raw), offset: m.index });
  }
  return out;
}
