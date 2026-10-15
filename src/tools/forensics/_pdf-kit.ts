/**
 * A small PDF writer for samples and tests: it puts objects into a file one after the other,
 * remembers where each one starts and writes classic xref tables and trailers, so incremental
 * updates, damaged files and odd layouts can be built by hand. It shares no code with the
 * analyzer (a test of the analyzer must not depend on the analyzer's own reading).
 */
import { zlibSync } from 'fflate';

export const bytesOf = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

export function join(...parts: (Uint8Array | string)[]): Uint8Array {
  const chunks = parts.map((p) => (typeof p === 'string' ? bytesOf(p) : p));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export const flate = (data: Uint8Array | string): Uint8Array =>
  zlibSync(typeof data === 'string' ? bytesOf(data) : data, { level: 9 });

export const pad10 = (n: number): string => String(n).padStart(10, '0');

export class PdfWriter {
  private chunks: Uint8Array[] = [];
  length = 0;
  /** Object number -> {offset, gen} of the latest definition written. */
  readonly offsets = new Map<number, { offset: number; gen: number }>();

  constructor(header: string | null = '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n') {
    if (header) this.raw(header);
  }

  raw(data: Uint8Array | string): this {
    const b = typeof data === 'string' ? bytesOf(data) : data;
    this.chunks.push(b);
    this.length += b.length;
    return this;
  }

  /** `num gen obj` + text + `endobj`. The text is a whole object: a dictionary, a number... */
  object(num: number, text: string, gen = 0): this {
    this.offsets.set(num, { offset: this.length, gen });
    return this.raw(`${num} ${gen} obj\n${text}\nendobj\n`);
  }

  /** A stream object; `dict` holds the entries without << >> and without /Length. */
  stream(num: number, dict: string, data: Uint8Array | string, gen = 0, lengthText?: string): this {
    const b = typeof data === 'string' ? bytesOf(data) : data;
    this.offsets.set(num, { offset: this.length, gen });
    return this.raw(
      join(
        `${num} ${gen} obj\n<< ${dict} /Length ${lengthText ?? b.length} >>\nstream\n`,
        b,
        '\nendstream\nendobj\n',
      ),
    );
  }

  /**
   * A classic xref section for the given objects (free entry 0 included when `withHead`),
   * the trailer, startxref and %%EOF. Returns the offset of the `xref` keyword.
   */
  xref(nums: number[], trailer: string, withHead = true): number {
    const at = this.length;
    const sorted = [...nums].sort((a, b) => a - b);
    let out = 'xref\n';
    const groups: number[][] = [];
    if (withHead) groups.push([0]);
    for (const n of sorted) {
      const g = groups[groups.length - 1];
      if (g && g[g.length - 1] === n - 1) g.push(n);
      else groups.push([n]);
    }
    for (const g of groups) {
      out += `${g[0]} ${g.length}\n`;
      for (const n of g) {
        if (n === 0) out += '0000000000 65535 f \n';
        else {
          const o = this.offsets.get(n);
          out += o
            ? `${pad10(o.offset)} ${String(o.gen).padStart(5, '0')} n \n`
            : '0000000000 00000 f \n';
        }
      }
    }
    this.raw(`${out}trailer\n<< ${trailer} >>\nstartxref\n${at}\n%%EOF\n`);
    return at;
  }

  bytes(): Uint8Array {
    const out = new Uint8Array(this.length);
    let o = 0;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }
}

/** The usual one-page skeleton: catalog 1, pages 2, page 3, content 4, font 5. */
export function simpleDocument(content: string | Uint8Array, extraCatalog = ''): PdfWriter {
  const w = new PdfWriter();
  w.object(1, `<< /Type /Catalog /Pages 2 0 R ${extraCatalog} >>`);
  w.object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  w.object(
    3,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
  );
  w.stream(4, '', content);
  w.object(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  return w;
}
