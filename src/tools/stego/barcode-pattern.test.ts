import { describe, expect, it } from 'vitest';
import type { WriterOptions } from 'zxing-wasm/writer';
import { ToolError } from '../../core/errors';
import { resultToText } from '../../core/result-text';
import type { Output, RgbaImage } from '../../core/types';
import { checkDigit, ean13Modules, makeBarcode } from './_barcode-fixtures';
import { flipped, MAX_SIDE, parseModules, parseWidths, renderPattern } from './_barcode-modules';
import pattern from './barcode-pattern';

const OPTIONS: Record<string, unknown> = { notation: 'modules', ones: 'bar', spaces: false };
const run = async (text: string, o: Record<string, unknown> = {}): Promise<Output[]> =>
  (await pattern.run(text, { ...OPTIONS, ...o } as never)) as Output[];
const decoded = (out: Output[]) => {
  const t = out.find((o) => o.type === 'text');
  return t?.type === 'text' ? t.value : null;
};
const kv = (out: Output[], key: string) => {
  for (const o of out) {
    if (o.type !== 'kv') continue;
    const hit = o.entries.find(([k]) => k === key);
    if (hit) return hit[1];
  }
  return undefined;
};
const P = { onesAreLight: false, spaceIsLight: false };

/** The modules of a code drawn one pixel per module with no quiet zone, as lines of 1 and 0. */
async function modulesOf(
  text: string,
  format: NonNullable<WriterOptions['format']>,
  oneRow: boolean,
): Promise<string> {
  const img: RgbaImage = await makeBarcode(text, { format, scale: 1, addQuietZones: false });
  const lines: string[] = [];
  for (let y = 0; y < img.height; y++) {
    let line = '';
    for (let x = 0; x < img.width; x++)
      line += img.data[(y * img.width + x) * 4]! < 128 ? '1' : '0';
    lines.push(line);
  }
  return oneRow ? lines[Math.floor(lines.length / 2)]! : lines.join('\n');
}

describe('reading the notations', () => {
  it('1 and 0, one line per row', () => {
    const p = parseModules('1011\n0110', P);
    expect(p.cols).toBe(4);
    expect(p.rows).toEqual([
      [true, false, true, true],
      [false, true, true, false],
    ]);
  });

  it('▮ and ▯ (and block characters) are dark and light whatever 1 means', () => {
    const swapped = { onesAreLight: true, spaceIsLight: false };
    expect(parseModules('▮▯█□', swapped).rows[0]).toEqual([true, false, true, false]);
    expect(parseModules('1001', swapped).rows[0]).toEqual([false, true, true, false]);
  });

  it('spaces and commas separate unless a space is a light module', () => {
    expect(parseModules('1 0 1,1', P).rows[0]).toEqual([true, false, true, true]);
    expect(parseModules('█ ██ █', { onesAreLight: false, spaceIsLight: true }).rows[0]).toEqual([
      true,
      false,
      true,
      true,
      false,
      true,
    ]);
  });

  it('says where an unknown character is', () => {
    expect(() => parseModules('101\n10a1', P)).toThrow(/“a” on line 2/);
    expect(() => parseModules('   ', P)).toThrow(ToolError);
  });

  it('refuses rows of different widths', () => {
    expect(() => parseModules('1010\n101', P)).toThrow(
      /Line 2 has 3 modules but the first line has 4/,
    );
  });

  it('refuses an enormous grid', () => {
    expect(() => parseModules('1'.repeat(MAX_SIDE + 1), P)).toThrow(/too large/);
  });

  it('widths: bar, space, bar... in modules', () => {
    expect(parseWidths('211').rows[0]).toEqual([true, true, false, true]);
    expect(parseWidths('2 1 12').cols).toBe(15);
    expect(parseWidths('1,1,1').rows[0]).toEqual([true, false, true]);
    expect(() => parseWidths('2 x')).toThrow(/widths list/);
    expect(() => parseWidths('0')).toThrow(/widths list/);
    expect(() => parseWidths('21\n12')).toThrow(/widths list/);
  });

  it('flipping swaps dark and light', () => {
    expect(flipped(parseModules('10', P)).rows[0]).toEqual([false, true]);
  });

  it('draws bars tall for one row and square modules for a grid', () => {
    const bars = renderPattern(parseModules('1010101', P));
    expect(bars.height).toBeGreaterThan(100);
    const grid = renderPattern(parseModules('10\n01', P));
    expect(grid.width).toBe(grid.height);
  });
});

describe('decoding a pattern', () => {
  const oneD: [NonNullable<WriterOptions['format']>, string, string][] = [
    ['Code128', 'FTF{bars}', 'Code 128'],
    ['Code39', 'FTF39', 'Code 39'],
    ['Code93', 'FTF93', 'Code 93'],
    ['Codabar', 'A1234A', 'Codabar'],
    ['ITF', '12345670', 'ITF'],
    ['EAN13', '201234567890', 'EAN-13'],
    ['EAN8', '2012345', 'EAN-8'],
  ];
  it.each(oneD)('1D: %s', async (writer, payload, name) => {
    const out = await run(await modulesOf(payload, writer, true));
    expect(kv(out, 'Format')).toBe(`${name} (1D)`);
    expect(decoded(out)).toBe(
      writer === 'EAN13'
        ? `${payload}${checkDigit(payload)}`
        : writer === 'EAN8'
          ? `${payload}${checkDigit(payload)}`
          : payload,
    );
    expect(kv(out, 'Size')).toMatch(/modules wide, one row/);
  });

  const twoD: [NonNullable<WriterOptions['format']>, string, string][] = [
    ['QRCode', 'FTF{grid}', 'QR Code'],
    ['MicroQRCode', 'FTF{m}', 'Micro QR Code'],
    ['DataMatrix', 'FTF{dm}', 'Data Matrix'],
    ['Aztec', 'FTF{az}', 'Aztec'],
  ];
  it.each(twoD)('2D grid: %s', async (writer, payload, name) => {
    const out = await run(await modulesOf(payload, writer, false));
    expect(kv(out, 'Format')).toBe(`${name} (2D)`);
    expect(decoded(out)).toBe(payload);
    expect(kv(out, 'Size')).toMatch(/modules \(2D grid\)/);
  });

  it('the same pattern with ▮ and ▯, and as widths', async () => {
    const row = await modulesOf('FTF{bars}', 'Code128', true);
    expect(decoded(await run([...row].map((c) => (c === '1' ? '▮' : '▯')).join('')))).toBe(
      'FTF{bars}',
    );
    const widths: number[] = [];
    for (let i = 0; i < row.length;) {
      let j = i;
      while (j < row.length && row[j] === row[i]) j++;
      widths.push(j - i);
      i = j;
    }
    expect(decoded(await run(widths.join(''), { notation: 'widths' }))).toBe('FTF{bars}');
    expect(decoded(await run(widths.join(' '), { notation: 'widths' }))).toBe('FTF{bars}');
  });

  it('1 and 0 the other way round are tried too, and the tool says so', async () => {
    const row = await modulesOf('FTF{bars}', 'Code128', true);
    const swapped = [...row].map((c) => (c === '1' ? '0' : '1')).join('');
    const out = await run(swapped);
    expect(decoded(out)).toBe('FTF{bars}');
    expect(kv(out, 'Reading')).toContain('1 and 0 swapped');
    expect(kv(out, 'Read after')).toContain('1 and 0 swapped');
    // Said so up front, no need to guess:
    expect(decoded(await run(swapped, { ones: 'space' }))).toBe('FTF{bars}');
  });

  it('bars drawn with block characters and spaces', async () => {
    const row = await modulesOf('FTF{bars}', 'Code128', true);
    const art = [...row].map((c) => (c === '1' ? '█' : ' ')).join('');
    expect(decoded(await run(art, { spaces: true }))).toBe('FTF{bars}');
  });

  it('a wrong check digit is reported, not hidden', async () => {
    const bits = ean13Modules('2012345678905');
    const out = await run(bits);
    expect(kv(out, 'Check')).toBe('FAILED: wrong check digit or checksum');
    expect(resultToText(out)).toContain('fails its own check');
  });

  it('a pattern that is no barcode says so plainly', async () => {
    const out = await run('1011001110001011010111010001');
    expect(out.at(-1)).toMatchObject({ type: 'note', level: 'warn' });
    expect(resultToText(out)).toMatch(
      /No barcode could be read from this pattern \(28 modules wide\)/,
    );
    expect(resultToText(out)).toContain('Barcode reader');
  });

  it('refuses nothing to read', async () => {
    await expect(run('')).rejects.toThrow(/Paste the pattern/);
  });
});
