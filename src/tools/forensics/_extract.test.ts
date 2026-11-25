import { readFileSync } from 'node:fs';
import { gzipSync, strToU8, zlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { concatBytes, latin1Encode, utf8Decode } from '../../lib/bytes';
import { crc32, identify } from '../../lib/signatures';
import { extract, flatten, type ExtractResult, type Node } from './_extract';
import { buildGif, buildJpeg, buildPng, buildTar, buildZip, noise } from './_fixtures';
import { buildEmbeddedJs } from './_pdf-fixtures';

// ---------- homemade builders (nothing here comes from a challenge) ----------

const be32 = (v: number) =>
  Uint8Array.of((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
const be16 = (v: number) => Uint8Array.of((v >>> 8) & 255, v & 255);

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const body = concatBytes(latin1Encode(type), data);
  return concatBytes(be32(data.length), body, be32(crc32(body)));
}

/** A PNG with a tEXt chunk added before IEND. */
function pngWithText(keyword: string, value: string, base = buildPng()): Uint8Array {
  const chunk = pngChunk(
    'tEXt',
    concatBytes(latin1Encode(keyword), Uint8Array.of(0), latin1Encode(value)),
  );
  return concatBytes(base.subarray(0, base.length - 12), chunk, base.subarray(base.length - 12));
}

const b64 = (s: string) => Buffer.from(s).toString('base64');

const FLAG = 'FTF{deep_in_the_tree}';

/** zip > layers/pic.png > tEXt Comment (base64) > the flag. */
const nestedZip = () =>
  buildZip([
    { name: 'readme.txt', data: strToU8('Nothing to see.\n') },
    { name: 'layers/pic.png', data: pngWithText('Comment', b64(FLAG)) },
  ]);

const find = (root: Node, predicate: (n: Node) => boolean): Node | undefined =>
  flatten(root).find((x) => predicate(x.node))?.node;
const paths = (r: ExtractResult) => flatten(r.root).map((x) => x.node.path);

// ---------- the tree ----------

describe('extract: a nested container', () => {
  it('unwraps zip > png > tEXt > base64 and surfaces the flag', async () => {
    const r = await extract(nestedZip(), { name: 'nest.zip' });
    expect(paths(r)).toEqual([
      'nest.zip',
      'nest.zip/readme.txt',
      'nest.zip/layers/pic.png',
      'nest.zip/layers/pic.png/tEXt-Comment',
      'nest.zip/layers/pic.png/tEXt-Comment/base64.txt',
    ]);
    const leaf = find(r.root, (n) => n.kind === 'decoded')!;
    expect(utf8Decode(leaf.bytes)).toBe(FLAG);
    expect(leaf.how).toBe('decode:base64');
    expect(leaf.format).toBe('text');
    expect(r.flags).toEqual([FLAG]);
    expect(r.truncated).toBe(false);
    expect(r.nodeCount).toBe(5);
  });

  it('classifies every node: root, container entries, an embedded chunk, a decoded blob', async () => {
    const r = await extract(nestedZip());
    const kinds = flatten(r.root).map((x) => [x.node.name, x.node.kind, x.node.format]);
    expect(kinds).toEqual([
      ['input', 'root', 'zip'],
      ['readme.txt', 'container', 'text'],
      ['layers/pic.png', 'container', 'png'],
      ['tEXt-Comment', 'embedded', 'text'],
      ['base64.txt', 'decoded', 'text'],
    ]);
    const png = find(r.root, (n) => n.format === 'png')!;
    expect(png.confirmed).toBe(true);
    expect(png.how).toBe('entry');
  });

  it('attributes a flag to the lowest node that holds it, and bubbles it to the result', async () => {
    const r = await extract(nestedZip());
    expect(r.root.flags).toEqual([]);
    const holders = flatten(r.root).filter((x) => x.node.flags.length > 0);
    expect(holders.map((x) => x.node.name)).toEqual(['base64.txt']);
    expect(holders[0]!.node.flags).toEqual([FLAG]);
  });

  it('does the same on the sample file shipped with the tool', async () => {
    const sample = new Uint8Array(
      readFileSync(new URL('../../../public/samples/extract-nested.zip', import.meta.url)),
    );
    const r = await extract(sample, { name: 'extract-nested.zip' });
    expect(r.flags).toEqual(['FTF{extract_unwraps_layers}']);
    const names = flatten(r.root).map((x) => x.node.name);
    expect(names).toEqual([
      'extract-nested.zip',
      'readme.txt',
      'layers/pic.png',
      'tEXt-Comment',
      'base64.txt',
      expect.stringMatching(/^[0-9a-f]{8}\.gz$/),
      expect.stringMatching(/^[0-9a-f]{8}\.txt$/),
    ]);
    const hint = find(r.root, (n) => n.kind === 'carved')!;
    expect(hint.how).toBe('carve:exact');
    expect(hint.confirmed).toBe(true);
    expect(utf8Decode(hint.children[0]!.bytes)).toContain('Comment chunk');
  });

  it('is deterministic', async () => {
    const shape = async () => {
      const r = await extract(nestedZip());
      return flatten(r.root).map((x) => [x.depth, x.node.path, x.node.size, x.node.how]);
    };
    expect(await shape()).toEqual(await shape());
  });
});

describe('extract: the other containers', () => {
  it('lists the files of a tar.gz and does not carve them a second time', async () => {
    const png = buildPng();
    const tgz = gzipSync(
      buildTar([
        ['a/pic.png', png],
        ['note.txt', strToU8('hello there')],
      ]),
      {
        mtime: 0,
      },
    );
    const r = await extract(tgz, { name: 'x.tgz' });
    expect(paths(r)).toEqual([
      'x.tgz',
      'x.tgz/x.tar',
      'x.tgz/x.tar/a/pic.png',
      'x.tgz/x.tar/note.txt',
    ]);
    const names = flatten(r.root).map((x) => x.node.name);
    expect(names.filter((n) => n.endsWith('pic.png'))).toHaveLength(1);
    expect(flatten(r.root).some((x) => x.node.kind === 'carved')).toBe(false);
    expect(find(r.root, (n) => n.format === 'tar')?.how).toBe('inflate');
  });

  it('inflates a zlib stream and a gzip stream found by carving', async () => {
    const text = b64('FTF{from_a_zlib}');
    const r = await extract(concatBytes(buildPng(), zlibSync(strToU8(text))));
    const inflated = find(r.root, (n) => n.how === 'inflate');
    expect(inflated).toBeDefined();
    expect(utf8Decode(inflated!.bytes)).toBe(text);
    expect(r.flags).toContain('FTF{from_a_zlib}');
  });

  it('finds the embedded file of a PDF, and the flag in it', async () => {
    const r = await extract(buildEmbeddedJs(), { name: 'doc.pdf' });
    const emb = find(r.root, (n) => n.kind === 'embedded')!;
    expect(emb.name).toBe('hidden-note.txt');
    expect(emb.how).toBe('embedded-file');
    expect(utf8Decode(emb.bytes)).toContain('FTF{embedded_file}');
    expect(emb.flags).toEqual(['FTF{embedded_file}']);
    expect(r.flags).toContain('FTF{embedded_file}');
  });

  it('turns the extra frames of an APNG into PNG files', async () => {
    const IHDR = concatBytes(be32(4), be32(4), Uint8Array.of(8, 0, 0, 0, 0));
    const idat = zlibSync(new Uint8Array(4 * 5));
    const fctl = (seq: number) =>
      concatBytes(
        be32(seq),
        be32(4),
        be32(4),
        be32(0),
        be32(0),
        be16(10),
        be16(10),
        Uint8Array.of(0, 0),
      );
    const apng = concatBytes(
      Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
      pngChunk('IHDR', IHDR),
      pngChunk('acTL', concatBytes(be32(3), be32(0))),
      pngChunk('fcTL', fctl(0)),
      pngChunk('IDAT', idat),
      pngChunk('fcTL', fctl(1)),
      pngChunk('fdAT', concatBytes(be32(2), idat)),
      pngChunk('fcTL', fctl(3)),
      pngChunk('fdAT', concatBytes(be32(4), idat)),
      pngChunk('IEND', new Uint8Array(0)),
    );
    const r = await extract(apng);
    const frames = r.root.children.filter((c) => c.how === 'frame');
    expect(frames.map((f) => f.name)).toEqual(['frame-000.png', 'frame-001.png', 'frame-002.png']);
    for (const f of frames) {
      expect(identify(f.bytes)[0]?.id).toBe('png');
      expect(f.confirmed).toBe(true);
    }
  });

  it('keeps the data of a private PNG chunk', async () => {
    const base = buildPng();
    const chunk = pngChunk('fLAg', strToU8(b64('FTF{private_chunk}')));
    const png = concatBytes(
      base.subarray(0, base.length - 12),
      chunk,
      base.subarray(base.length - 12),
    );
    const r = await extract(png);
    expect(find(r.root, (n) => n.name === 'chunk-fLAg')?.how).toBe('chunk');
    expect(r.flags).toEqual(['FTF{private_chunk}']);
  });
});

describe('extract: carving', () => {
  it('lists a JPEG glued after a PNG as a confirmed carved file', async () => {
    const png = buildPng();
    const jpg = buildJpeg();
    const r = await extract(concatBytes(png, jpg));
    expect(r.root.format).toBe('png');
    const carved = r.root.children.filter((c) => c.kind === 'carved');
    expect(carved).toHaveLength(1);
    expect(carved[0]!.format).toBe('jpeg');
    expect(carved[0]!.offset).toBe(png.length);
    expect(carved[0]!.size).toBe(jpg.length);
    expect(carved[0]!.confirmed).toBe(true);
    expect(carved[0]!.how).toBe('carve:exact');
    expect(carved[0]!.path).toBe(`input/${carved[0]!.name}`);
  });

  it('marks a file cut short as a candidate, not a confirmed file', async () => {
    const png = buildPng();
    const jpg = buildJpeg();
    const r = await extract(concatBytes(png, jpg.subarray(0, jpg.length - 40)));
    const carved = r.root.children.find((c) => c.kind === 'carved')!;
    expect(carved.format).toBe('jpeg');
    expect(carved.confirmed).toBe(false);
    expect(['carve:truncated', 'carve:guess']).toContain(carved.how);
  });

  it('keeps plain bytes after a file as a trailing blob', async () => {
    const png = buildPng();
    const r = await extract(concatBytes(png, strToU8(b64('FTF{after_iend}'))));
    const tail = r.root.children.find((c) => c.how === 'trailing')!;
    expect(tail.offset).toBe(png.length);
    expect(tail.confirmed).toBe(false);
    expect(r.flags).toContain('FTF{after_iend}');
  });

  it('a carved child is always smaller than its parent (no self-reference)', async () => {
    const gif = buildGif();
    const blob = concatBytes(buildPng(), gif, buildJpeg(), nestedZip());
    const r = await extract(blob);
    for (const { node } of flatten(r.root)) {
      for (const c of node.children) {
        if (c.kind === 'carved') expect(c.size).toBeLessThan(node.size);
      }
    }
    expect(r.root.children.some((c) => c.format === 'zip')).toBe(true);
    // The ZIP found by carving is opened like any other.
    expect(r.flags).toContain(FLAG);
  });

  it('can be told not to carve or not to decode', async () => {
    const blob = concatBytes(buildPng(), buildGif());
    expect((await extract(blob, { carve: false })).nodeCount).toBe(1);
    const noDecode = await extract(nestedZip(), { decode: false });
    expect(noDecode.flags).toEqual([]);
    expect(noDecode.nodeCount).toBe(4);
  });
});

describe('extract: text', () => {
  it('decodes a text blob and recurses into what it finds', async () => {
    // hex of base64 of the flag
    const hex = Buffer.from(b64(FLAG)).toString('hex');
    const r = await extract(strToU8(hex));
    const steps = flatten(r.root)
      .filter((x) => x.node.kind === 'decoded')
      .map((x) => x.node.how);
    expect(steps).toEqual(['decode:hex', 'decode:base64']);
    expect(r.flags).toEqual([FLAG]);
  });

  it('leaves plain text alone', async () => {
    const r = await extract(strToU8('The quick brown fox jumps over the lazy dog, twice.'));
    expect(r.nodeCount).toBe(1);
    expect(r.flags).toEqual([]);
  });

  it('finds a flag in plain text at the root', async () => {
    const r = await extract(strToU8('hello flag{plain_one} bye'));
    expect(r.flags).toEqual(['flag{plain_one}']);
    expect(r.root.flags).toEqual(['flag{plain_one}']);
  });
});

describe('extract: no false tree', () => {
  it.each([1, 2, 3, 4, 5, 6])(
    'random bytes (seed %i) give the root and nothing else',
    async (seed) => {
      const r = await extract(noise(200_000, seed * 7919, false));
      expect(r.nodeCount).toBe(1);
      expect(r.root.children).toEqual([]);
      expect(r.flags).toEqual([]);
      expect(r.truncated).toBe(false);
    },
  );

  it('random printable bytes give no children either', async () => {
    const r = await extract(noise(100_000, 99, true));
    expect(r.root.children).toEqual([]);
  });

  it('an empty input is a lone root', async () => {
    const r = await extract(new Uint8Array(0));
    expect(r.nodeCount).toBe(1);
    expect(r.root.children).toEqual([]);
  });
});

// ---------- the bounds ----------

describe('extract: bounds', () => {
  const MIB = 1024 * 1024;

  it('stops at the depth limit and says so', async () => {
    let data: Uint8Array = strToU8('core');
    for (let i = 0; i < 12; i++) data = gzipSync(data, { mtime: 0 });
    const r = await extract(data);
    expect(r.truncated).toBe(true);
    expect(r.notes.some((n) => n.code === 'depth')).toBe(true);
    const deepest = Math.max(...flatten(r.root).map((x) => x.depth));
    expect(deepest).toBe(6);
    expect(r.nodeCount).toBe(7);
    // Asked for a deeper walk, the same file unwinds fully.
    const full = await extract(data, { maxDepth: 20 });
    expect(full.truncated).toBe(false);
    expect(utf8Decode(find(full.root, (n) => n.children.length === 0)!.bytes)).toBe('core');
  });

  it('refuses a gzip bomb: the output never goes past the budget', async () => {
    const bomb = gzipSync(new Uint8Array(16 * MIB), { level: 9, mtime: 0 });
    expect(bomb.length).toBeLessThan(64 * 1024);
    const r = await extract(bomb, { maxBytes: 2 * MIB });
    expect(r.truncated).toBe(true);
    expect(r.notes.some((n) => n.code === 'bytes')).toBe(true);
    expect(r.byteBudgetSpent).toBeLessThanOrEqual(2 * MIB);
    expect(r.root.children).toEqual([]);
  });

  it('refuses a zip entry that expands past the budget, whatever its header claims', async () => {
    const zip = buildZip([
      { name: 'small.txt', data: strToU8('fine') },
      { name: 'bomb.bin', data: new Uint8Array(16 * MIB) },
    ]);
    expect(zip.length).toBeLessThan(64 * 1024);
    const r = await extract(zip, { maxBytes: 2 * MIB });
    expect(r.truncated).toBe(true);
    expect(r.byteBudgetSpent).toBeLessThanOrEqual(2 * MIB);
    expect(r.root.children.map((c) => c.name)).toEqual(['small.txt']);
  });

  it('shares one budget across the whole tree', async () => {
    const chunk = noise(300 * 1024, 5, false);
    const zip = buildZip(
      Array.from({ length: 10 }, (_, i) => ({
        name: `f${i}.bin`,
        data: chunk,
        method: 8 as const,
      })),
    );
    const r = await extract(zip, { maxBytes: MIB });
    expect(r.truncated).toBe(true);
    expect(r.byteBudgetSpent).toBeLessThanOrEqual(MIB);
    expect(r.root.children.length).toBeGreaterThan(0);
    expect(r.root.children.length).toBeLessThan(10);
  });

  it('caps the number of nodes', async () => {
    const zip = buildZip(
      Array.from({ length: 200 }, (_, i) => ({ name: `f${i}.txt`, data: strToU8(`file ${i}`) })),
    );
    const r = await extract(zip, { maxNodes: 25 });
    expect(r.truncated).toBe(true);
    expect(r.nodeCount).toBe(25);
    expect(flatten(r.root)).toHaveLength(25);
    expect(r.notes.some((n) => n.code === 'nodes')).toBe(true);
  });

  it('does not hang on a ZIP made of thousands of entries', async () => {
    const zip = buildZip(
      Array.from({ length: 5000 }, (_, i) => ({
        name: `d/${i}.txt`,
        data: strToU8(`n${i}`),
        method: 0 as const,
      })),
    );
    const r = await extract(zip);
    expect(r.nodeCount).toBeLessThanOrEqual(4096);
    expect(r.truncated).toBe(true);
  });

  it('stops scanning when the work budget is spent', async () => {
    const r = await extract(concatBytes(buildPng(), buildGif()), { maxWork: 10 });
    expect(r.truncated).toBe(true);
    expect(r.notes.some((n) => n.code === 'work')).toBe(true);
    expect(r.nodeCount).toBe(1);
  });
});
