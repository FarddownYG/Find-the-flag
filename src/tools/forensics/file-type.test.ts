import { describe, expect, it } from 'vitest';
import type { Output } from '../../core/types';
import { latin1Encode } from '../../lib/bytes';
import fileType from './file-type';

const run = (bytes: Uint8Array, name?: string) =>
  Promise.resolve(fileType.run({ bytes, name }, {} as never)) as Promise<Output[]>;
const notes = (out: Output[]) => out.flatMap((o) => (o.type === 'note' ? [o.text] : []));

describe('file type: PDF cross-link', () => {
  it('points at the PDF analyzer for a PDF, and only for a PDF', async () => {
    const pdf = await run(latin1Encode('%PDF-1.7\n%%EOF\n'), 'a.pdf');
    expect(notes(pdf)).toContain(
      'This is a PDF. The PDF analyzer lists its objects, revisions, hidden text, scripts and embedded files.',
    );
    const png = await run(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(notes(png).some((n) => n.includes('PDF analyzer'))).toBe(false);
  });
});
