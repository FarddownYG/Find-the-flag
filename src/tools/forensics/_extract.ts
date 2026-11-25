/**
 * The universal extractor: a recursive, bounded tree of what a file holds. A node is parsed as a
 * container (ZIP, TAR, gzip, zlib, PDF embedded files, PNG chunks and APNG frames), scanned for
 * embedded files by magic bytes (carving), and, when it is text, run through the text decoders.
 * Every child is expanded the same way, down to a depth limit.
 *
 * Pure and deterministic: bytes in, tree out, no clock and no randomness. Language-free too: a
 * node carries stable codes (`format`, `how`) and the tool turns them into words.
 *
 * Bounds (a crafted file must not hang or exhaust the tab):
 *  - `maxBytes`: output bytes allocated by every inflate / decode / extraction together. Views of
 *    the parent's buffer (a carved file, a stored ZIP entry) cost nothing here.
 *  - `maxDepth`, `maxNodes`.
 *  - `maxWork`: bytes scanned by the carver and the flag search, summed over all nodes.
 *  When one is hit, expansion stops there and the result is `truncated`.
 */
import { Gunzip, Unzlib } from 'fflate';
import { buildFlagRegex, KNOWN_PREFIX, selectFlags } from '../../core/flags';
import { concatBytes, latin1Decode, latin1Encode, u32be, u32le, utf8Encode } from '../../lib/bytes';
import { adler32, deflateScan, identify, tarHeaderValid } from '../../lib/signatures';
import { plaintextScore } from '../../lib/english';
import { analyse, buildCtx, DECODERS } from '../encoding/_decoders';
import { isGzip, isZlib } from '../encoding/_inflate';
import { apngFrames, isApng } from '../stego/_png-surgeon-apng';
import { looksLikePng, parseTolerant } from '../stego/_png-surgeon-parse';
import { decodeTextChunk, KNOWN_CHUNKS } from '../stego/_png';
import { safeName } from './archive';
import { carveAll } from './carve';
import { PdfDoc } from './_pdf-doc';
import { computeReach, findEmbedded } from './_pdf-find';
import { parseTar } from './_tar';
import { extractZipEntry, parseZip } from './_zip';

export type NodeKind = 'root' | 'container' | 'carved' | 'decoded' | 'embedded';

export interface Node {
  kind: NodeKind;
  /**
   * What the bytes are: a signature id ('png', 'zip', 'gzip'...), 'text' or 'data'. A decoded
   * node has the format of what came out, not of the decoder.
   */
  format: string;
  /** Slash-joined names from the input down to this node. */
  path: string;
  /** This node's own name (the last segment of the path). */
  name: string;
  /** Offset inside the parent, when the node is a slice of it. */
  offset?: number;
  size: number;
  bytes: Uint8Array;
  /** True when structure proves it is a whole file (a ZIP entry, an exact carve, an APNG frame). */
  confirmed: boolean;
  /**
   * How it was found, as a code: input · entry · inflate · text-chunk · chunk · frame ·
   * embedded-file · carve:exact · carve:truncated · carve:guess · trailing · decode:<step>.
   */
  how: string;
  /** Flag candidates whose deepest home is this node (a flag is listed once, at the lowest node). */
  flags: string[];
  children: Node[];
}

export type NoteCode = 'depth' | 'nodes' | 'bytes' | 'work' | 'encrypted' | 'pdf-failed';

export interface ExtractNote {
  code: NoteCode;
  path: string;
  detail?: string;
}

export interface ExtractOptions {
  /** Levels below the input that are expanded (default 6). */
  maxDepth?: number;
  /** Nodes in the tree, the input included (default 4096). */
  maxNodes?: number;
  /** Output bytes allocated while extracting (default 256 MiB). */
  maxBytes?: number;
  /** Bytes scanned by carving and the flag search, over all nodes (default 1 GiB). */
  maxWork?: number;
  /** Look for embedded files by magic bytes (default true). */
  carve?: boolean;
  /** Run the text decoders on text nodes (default true). */
  decode?: boolean;
  /** Name of the input (default "input"). */
  name?: string;
  /** Extra flag pattern (regex source), on top of the built-in ones. */
  flagPattern?: string;
}

export interface ExtractResult {
  root: Node;
  truncated: boolean;
  nodeCount: number;
  /** Output bytes allocated so far (what `maxBytes` bounds). */
  byteBudgetSpent: number;
  /** Every flag candidate of the tree, once each, in discovery order. */
  flags: string[];
  notes: ExtractNote[];
}

export const MAX_DEPTH = 6;
export const MAX_NODES = 4096;
export const MAX_BYTES = 256 * 1024 * 1024;
const MAX_WORK = 1024 * 1024 * 1024;
/** The flag search reads at most this much of one node. */
const FLAG_SCAN = 8 * 1024 * 1024;
const MAX_DECODED_PER_NODE = 4;
const MAX_FRAMES = 256;
const MIN_TEXT_CHUNK = 4;
/** Decoding steps a text may need before it turns into something readable (hex > base64 > text). */
const LOOKAHEAD = 2;
/** A flag format of this project, on top of flag{} CTF{} picoCTF{} and the like. */
const OWN_FLAGS = String.raw`FTF\{[^{}\s]{2,200}\}`;

// ---------- state ----------

interface State {
  maxDepth: number;
  maxNodes: number;
  maxBytes: number;
  maxWork: number;
  carve: boolean;
  decode: boolean;
  flagCustom: string;
  flagRe: RegExp;
  nodes: number;
  spent: number;
  work: number;
  truncated: boolean;
  notes: ExtractNote[];
  flags: string[];
  flagSet: Set<string>;
}

function stop(st: State, code: NoteCode, path: string, detail?: string): void {
  st.truncated = true;
  if (!st.notes.some((n) => n.code === code && n.path === path)) {
    st.notes.push({ code, path, detail });
  }
}

/** A finding that does not cut the tree short (an encrypted entry, a PDF that would not open). */
function note(st: State, code: NoteCode, path: string, detail?: string): void {
  if (!st.notes.some((n) => n.code === code && n.path === path)) {
    st.notes.push({ code, path, detail });
  }
}

const remaining = (st: State) => Math.max(0, st.maxBytes - st.spent);

/** Cheap content key (length + two hashes): loop and duplicate detection, not security. */
function keyOf(b: Uint8Array): string {
  let h1 = 0x811c9dc5;
  let h2 = 5381;
  for (let i = 0; i < b.length; i++) {
    h1 = Math.imul(h1 ^ b[i]!, 0x01000193);
    h2 = (Math.imul(h2, 33) + b[i]!) | 0;
  }
  return `${b.length}:${(h1 >>> 0).toString(36)}:${(h2 >>> 0).toString(36)}`;
}

// ---------- formats ----------

function formatOf(b: Uint8Array): string {
  const sig = identify(b)[0];
  if (sig) return sig.id;
  return analyse(b).textLike ? 'text' : 'data';
}

function extOf(b: Uint8Array): string {
  const sig = identify(b).find((s) => !s.weak);
  if (sig) return sig.ext;
  return analyse(b).textLike ? 'txt' : 'bin';
}

type Structure = 'zip' | 'tar' | 'gzip' | 'zlib' | 'pdf' | 'png';

const isPdf = (b: Uint8Array) =>
  b.length > 8 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d;

/** The container parser that applies to the start of `b`, if any. Cheap: no inflating here. */
function structureOf(b: Uint8Array): Structure | null {
  if (b.length < 8) return null;
  if (u32le(b, 0) === 0x04034b50 || u32le(b, 0) === 0x06054b50) return 'zip';
  if (b[0] === 0x1f && b[1] === 0x8b && b[2] === 8) return 'gzip';
  if (isPdf(b)) return 'pdf';
  if (looksLikePng(b)) return 'png';
  if (tarHeaderValid(b, 0)) return 'tar';
  if (isZlib(b) && (b[0]! & 0x0f) === 8 && b[0]! >> 4 <= 7 && deflateScan(b, 2) !== null) {
    return 'zlib';
  }
  return null;
}

// ---------- flags ----------

function flagsOf(st: State, b: Uint8Array, textLike: boolean): string[] {
  const text = latin1Decode(b.length > FLAG_SCAN ? b.subarray(0, FLAG_SCAN) : b);
  const found = [...selectFlags(text, st.flagRe, st.flagCustom)];
  // Binary data is full of lookalikes: only the well-known prefixes count there.
  const strong = new RegExp(`^(?:${st.flagCustom})$`);
  return textLike ? found : found.filter((f) => KNOWN_PREFIX.test(f) || strong.test(f));
}

// ---------- nodes ----------

function makeNode(
  kind: NodeKind,
  parent: Node,
  name: string,
  bytes: Uint8Array,
  how: string,
  confirmed: boolean,
  offset?: number,
): Node {
  const sameBuffer = bytes.buffer === parent.bytes.buffer;
  const at =
    offset ??
    (sameBuffer && bytes.byteOffset >= parent.bytes.byteOffset
      ? bytes.byteOffset - parent.bytes.byteOffset
      : undefined);
  return {
    kind,
    format: formatOf(bytes),
    path: `${parent.path}/${name}`,
    name,
    offset: at,
    size: bytes.length,
    bytes,
    confirmed,
    how,
    flags: [],
    children: [],
  };
}

/** Add a child if the bounds allow it. Fresh bytes (not a view of the parent) use the budget. */
function attach(st: State, parent: Node, child: Node): Node | null {
  if (st.nodes >= st.maxNodes) {
    stop(st, 'nodes', parent.path);
    return null;
  }
  const fresh = child.bytes.buffer === parent.bytes.buffer ? 0 : child.bytes.length;
  if (st.spent + fresh > st.maxBytes) {
    stop(st, 'bytes', parent.path);
    return null;
  }
  st.spent += fresh;
  st.nodes++;
  parent.children.push(child);
  return child;
}

function add(
  st: State,
  parent: Node,
  kind: NodeKind,
  name: string,
  bytes: Uint8Array,
  how: string,
  confirmed: boolean,
  offset?: number,
): Node | null {
  if (bytes.length === 0) return null;
  return attach(st, parent, makeNode(kind, parent, name, bytes, how, confirmed, offset));
}

const hex8 = (n: number) => n.toString(16).padStart(8, '0');

/** "photo.png.gz" -> "photo.png"; "dump" -> "dump.txt" / "dump.bin" by what came out. */
function unwrapName(name: string, data: Uint8Array): string {
  const base = name.replace(/\.(gz|tgz|z|zlib)$/i, '') || 'data';
  return /\.[A-Za-z0-9]{1,5}$/.test(base) ? base : `${base}.${extOf(data)}`;
}

// ---------- inflate with a ceiling ----------

/** gzip or zlib with an output ceiling: `overflow` when the data would be larger than `cap`. */
function inflateBounded(
  b: Uint8Array,
  kind: 'gzip' | 'zlib',
  cap: number,
): { data: Uint8Array | null; overflow: boolean } {
  const parts: Uint8Array[] = [];
  let total = 0;
  let overflow = false;
  const onData = (chunk: Uint8Array) => {
    total += chunk.length;
    if (total > cap) {
      overflow = true;
      throw new RangeError('over the ceiling');
    }
    parts.push(chunk);
  };
  try {
    const z = kind === 'gzip' ? new Gunzip(onData) : new Unzlib(onData);
    const step = 1 << 14;
    for (let i = 0; i < b.length; i += step) z.push(b.subarray(i, i + step), i + step >= b.length);
  } catch {
    return { data: null, overflow };
  }
  return { data: total > 0 ? concatBytes(...parts) : null, overflow: false };
}

// ---------- structural parsers ----------

function zipChildren(st: State, node: Node): void {
  const b = node.bytes;
  const info = parseZip(b);
  if (!info) return;
  for (const e of info.entries) {
    if (e.kind !== 'file') continue;
    if (st.nodes >= st.maxNodes) {
      stop(st, 'nodes', node.path);
      return;
    }
    const name = safeName(e.name).name;
    if (e.encrypted || e.aes) {
      note(st, 'encrypted', `${node.path}/${name}`);
      continue;
    }
    if (e.dataStart < 0 || (e.method !== 0 && e.method !== 8)) continue;
    if (e.method === 8) {
      // The real expanded size comes from walking the stream, not from the header (which lies).
      const raw = b.subarray(e.dataStart, Math.min(b.length, e.dataStart + e.csize));
      const scan = deflateScan(raw, 0);
      if (!scan) continue;
      if (scan.size > remaining(st)) {
        stop(st, 'bytes', `${node.path}/${name}`);
        continue;
      }
    }
    const r = extractZipEntry(b, e, null);
    if (!r.data) continue;
    add(st, node, 'container', name, r.data, 'entry', r.crcOk !== false);
  }
}

function tarChildren(st: State, node: Node): void {
  const info = parseTar(node.bytes);
  if (!info) return;
  for (const e of info.entries) {
    if (e.kind !== 'file') continue;
    if (st.nodes >= st.maxNodes) {
      stop(st, 'nodes', node.path);
      return;
    }
    add(st, node, 'container', safeName(e.name).name, e.data, 'entry', true);
  }
}

function gzipChildren(st: State, node: Node): void {
  const r = inflateBounded(node.bytes, 'gzip', remaining(st));
  if (r.overflow) stop(st, 'bytes', node.path);
  if (r.data) add(st, node, 'container', unwrapName(node.name, r.data), r.data, 'inflate', true);
}

function zlibChildren(st: State, node: Node): void {
  const b = node.bytes;
  const r = inflateBounded(b, 'zlib', remaining(st));
  if (r.overflow) stop(st, 'bytes', node.path);
  if (!r.data) return;
  const scan = deflateScan(b, 2);
  const checked =
    scan !== null && scan.end + 4 <= b.length && adler32(r.data) === u32be(b, scan.end);
  add(st, node, 'container', unwrapName(node.name, r.data), r.data, 'inflate', checked);
}

function pngChildren(st: State, node: Node): void {
  const parse = parseTolerant(node.bytes);
  if (!parse) return;
  for (const c of parse.chunks) {
    if (c.type === 'tEXt' || c.type === 'zTXt' || c.type === 'iTXt') {
      const t = decodeTextChunk(c.type, c.data);
      if (!t) continue;
      const bytes = c.type === 'iTXt' ? utf8Encode(t.text) : latin1Encode(t.text);
      if (bytes.length < MIN_TEXT_CHUNK) continue;
      add(st, node, 'embedded', `${c.type}-${t.keyword || 'text'}`, bytes, 'text-chunk', false);
    } else if (!(c.type in KNOWN_CHUNKS) && c.length >= MIN_TEXT_CHUNK) {
      // A chunk type the PNG specification does not know: someone put it there.
      add(st, node, 'embedded', `chunk-${c.type}`, c.data, 'chunk', false);
    }
  }
  if (isApng(parse.chunks)) {
    const ihdr = parse.chunks.find((c) => c.type === 'IHDR');
    if (!ihdr) return;
    const frames = apngFrames(parse.chunks, ihdr.data, {
      maxFrames: MAX_FRAMES,
      maxBytes: remaining(st),
    });
    for (const f of frames) {
      if (f.isDefault) continue;
      add(
        st,
        node,
        'embedded',
        `frame-${String(f.index).padStart(3, '0')}.png`,
        f.png,
        'frame',
        true,
      );
    }
  }
}

async function pdfChildren(st: State, node: Node): Promise<void> {
  try {
    const doc = await PdfDoc.open(node.bytes);
    if (doc.encrypt !== null && doc.decryptor === null) {
      note(st, 'encrypted', node.path);
      return;
    }
    const reach = computeReach(doc);
    for (const f of findEmbedded(doc, reach)) {
      if (f.data.length > remaining(st)) {
        stop(st, 'bytes', node.path);
        continue;
      }
      add(
        st,
        node,
        'embedded',
        safeName(f.name || 'embedded').name,
        f.data,
        'embedded-file',
        !f.truncated,
      );
    }
  } catch (e) {
    note(st, 'pdf-failed', node.path, e instanceof Error ? e.message : String(e));
  }
}

async function structuralChildren(st: State, node: Node, kind: Structure): Promise<void> {
  switch (kind) {
    case 'zip':
      return zipChildren(st, node);
    case 'tar':
      return tarChildren(st, node);
    case 'gzip':
      return gzipChildren(st, node);
    case 'zlib':
      return zlibChildren(st, node);
    case 'png':
      return pngChildren(st, node);
    case 'pdf':
      return pdfChildren(st, node);
  }
}

// ---------- carving ----------

function carveChildren(st: State, node: Node): void {
  const b = node.bytes;
  const { found, container } = carveAll(b, { container: false, nested: false, only: new Set() });
  // What the structural parser already handed out is not carved a second time.
  const covered = node.children
    .filter((c) => c.offset !== undefined)
    .map((c) => [c.offset!, c.offset! + c.size] as const);
  const isCovered = (at: number) => covered.some(([s, e]) => at >= s && at < e);
  for (const f of found) {
    if (st.nodes >= st.maxNodes) {
      stop(st, 'nodes', node.path);
      return;
    }
    if (isCovered(f.start) || (f.start === 0 && f.end >= b.length)) continue;
    const confirmed = f.exact && !f.truncated;
    const how = confirmed ? 'carve:exact' : f.truncated ? 'carve:truncated' : 'carve:guess';
    add(
      st,
      node,
      'carved',
      `${hex8(f.start)}.${f.sig.ext}`,
      b.subarray(f.start, f.end),
      how,
      confirmed,
      f.start,
    );
  }
  // Bytes after the end of the file at offset 0 that nothing recognised (a note, a key...).
  if (container?.exact && !container.truncated && container.end < b.length) {
    const after = container.end;
    if (!found.some((f) => f.start >= after)) {
      add(
        st,
        node,
        'carved',
        `trailing-${hex8(after)}.bin`,
        b.subarray(after),
        'trailing',
        false,
        after,
      );
    }
  }
}

// ---------- decoding ----------

/** Run every decoder on `ctx` and hand each non-empty output to `each`; true stops the loop. */
function tryDecoders(
  ctx: ReturnType<typeof buildCtx>,
  each: (out: Uint8Array) => boolean,
): boolean {
  for (const step of DECODERS) {
    let out: Uint8Array | null;
    try {
      out = step.run(ctx);
    } catch {
      out = null;
    }
    if (out && out.length > 0 && each(out)) return true;
  }
  return false;
}

/**
 * Is a decoded blob worth a node? A file, a compressed stream, a flag, or clear text. A text that
 * is itself encoded (hex of Base64...) also counts when `ahead` more decoding turns it into one of
 * those: layered encodings are the rule in CTFs, and the middle layer reads like noise.
 */
function plausible(st: State, out: Uint8Array, ahead: number): { ok: boolean; confirmed: boolean } {
  const sig = identify(out.subarray(0, 600)).find((s) => !s.weak);
  if (sig) return { ok: true, confirmed: true };
  if (isGzip(out) || isZlib(out)) return { ok: true, confirmed: false };
  const info = analyse(out);
  if (!info.textLike || info.text === null) return { ok: false, confirmed: false };
  if (flagsOf(st, out, true).length > 0) return { ok: true, confirmed: false };
  const sample = info.text.length > 4096 ? info.text.slice(0, 4096) : info.text;
  if (out.length >= 4 && plaintextScore(sample) >= 60) return { ok: true, confirmed: false };
  if (ahead > 0) {
    const deeper = tryDecoders(buildCtx(out), (next) => plausible(st, next, ahead - 1).ok);
    if (deeper) return { ok: true, confirmed: false };
  }
  return { ok: false, confirmed: false };
}

function decodeChildren(st: State, node: Node, chain: Set<string>): void {
  const ctx = buildCtx(node.bytes);
  if (!ctx.textLike) return;
  const seen = new Set<string>(chain);
  let added = 0;
  for (const step of DECODERS) {
    if (added >= MAX_DECODED_PER_NODE) return;
    let out: Uint8Array | null;
    try {
      out = step.run(ctx);
    } catch {
      out = null;
    }
    if (!out || out.length === 0) continue;
    const key = keyOf(out);
    if (seen.has(key)) continue;
    const verdict = plausible(st, out, LOOKAHEAD);
    if (!verdict.ok) continue;
    seen.add(key);
    const name = `${step.name.replace(/\s+/g, '-')}.${extOf(out)}`;
    if (add(st, node, 'decoded', name, out, `decode:${step.name}`, verdict.confirmed)) added++;
  }
}

// ---------- the walk ----------

async function expand(
  st: State,
  node: Node,
  depth: number,
  chain: Set<string>,
): Promise<Set<string>> {
  const info = analyse(node.bytes);
  const own = flagsOf(st, node.bytes, info.textLike);
  for (const f of own) {
    if (!st.flagSet.has(f)) {
      st.flagSet.add(f);
      st.flags.push(f);
    }
  }
  const structure = structureOf(node.bytes);
  const below = new Set<string>();

  if (depth >= st.maxDepth) {
    // A container we cannot open any further is the reason the tree is cut here.
    if (structure !== null) stop(st, 'depth', node.path);
  } else if (st.work + node.size > st.maxWork) {
    stop(st, 'work', node.path);
  } else {
    st.work += node.size;
    if (structure !== null) await structuralChildren(st, node, structure);
    if (st.carve && !info.textLike) carveChildren(st, node);
    if (st.decode && info.textLike) decodeChildren(st, node, chain);
    const next = new Set(chain).add(keyOf(node.bytes));
    // A child that is the very same content as an ancestor would only loop: drop it.
    node.children = node.children.filter((c) => {
      const same = next.has(keyOf(c.bytes));
      if (same) st.nodes--;
      return !same;
    });
    for (const child of node.children) {
      for (const f of await expand(st, child, depth + 1, next)) below.add(f);
    }
  }
  node.flags = own.filter((f) => !below.has(f));
  return new Set([...own, ...below]);
}

export async function extract(
  bytes: Uint8Array,
  opts: ExtractOptions = {},
): Promise<ExtractResult> {
  const custom = opts.flagPattern?.trim() ? `${OWN_FLAGS}|${opts.flagPattern.trim()}` : OWN_FLAGS;
  const st: State = {
    maxDepth: Math.max(0, Math.floor(opts.maxDepth ?? MAX_DEPTH)),
    maxNodes: Math.max(1, Math.floor(opts.maxNodes ?? MAX_NODES)),
    maxBytes: Math.max(0, Math.floor(opts.maxBytes ?? MAX_BYTES)),
    maxWork: Math.max(0, Math.floor(opts.maxWork ?? MAX_WORK)),
    carve: opts.carve ?? true,
    decode: opts.decode ?? true,
    flagCustom: custom,
    flagRe: buildFlagRegex(custom),
    nodes: 1,
    spent: 0,
    work: 0,
    truncated: false,
    notes: [],
    flags: [],
    flagSet: new Set(),
  };
  const name = opts.name?.trim() || 'input';
  const root: Node = {
    kind: 'root',
    format: formatOf(bytes),
    path: name,
    name,
    size: bytes.length,
    bytes,
    confirmed: true,
    how: 'input',
    flags: [],
    children: [],
  };
  await expand(st, root, 0, new Set());
  return {
    root,
    truncated: st.truncated,
    nodeCount: st.nodes,
    byteBudgetSpent: st.spent,
    flags: st.flags,
    notes: st.notes,
  };
}

/** The tree flattened depth-first, each node with its depth. */
export function flatten(root: Node): { node: Node; depth: number }[] {
  const out: { node: Node; depth: number }[] = [];
  const walk = (n: Node, depth: number) => {
    out.push({ node: n, depth });
    for (const c of n.children) walk(c, depth + 1);
  };
  walk(root, 0);
  return out;
}
