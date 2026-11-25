import { bool, defineTool, number } from '../../core/define';
import { ToolError } from '../../core/errors';
import { registeredTools } from '../../core/tool-list';
import type { Output } from '../../core/types';
import { buildWriteup, FLAG_MASK, kvTable, mdTable } from '../../core/writeup';
import { signatureName, toolName, toolT } from '../../i18n/tool-text';
import { formatSize, utf8Decode } from '../../lib/bytes';
import { SIGNATURES } from '../../lib/signatures';
import {
  extract,
  flatten,
  MAX_BYTES,
  MAX_DEPTH,
  MAX_NODES,
  type ExtractNote,
  type Node,
} from './_extract';

const T = toolT('extract');

const MIB = 1024 * 1024;
const DEFAULT_READ_MIB = 64;
/** Files above this size are handed over as a Blob instead of a copy of the bytes. */
const BLOB_FROM = 8 * MIB;
const MAX_FILES = 200;
const MAX_FILES_BYTES = 128 * MIB;
const MAX_ACTIONS = 5;
const ACTION_TEXT = 20_000;

const IMAGES = new Set(['png', 'jpeg', 'gif', 'bmp', 'webp', 'tiff']);

/** "ZIP archive (also docx, xlsx...)" -> "ZIP archive". */
const shortName = (name: string) => name.replace(/\s*[(（].*$/, '');

function formatName(id: string): string {
  if (id === 'text') return T('format.text');
  if (id === 'data') return T('format.data');
  const sig = SIGNATURES.find((s) => s.id === id);
  return sig ? shortName(signatureName(sig)) : id;
}

function howText(how: string): string {
  if (how.startsWith('decode:')) return T('how.decode', { step: how.slice('decode:'.length) });
  switch (how) {
    case 'input':
      return T('how.input');
    case 'entry':
      return T('how.entry');
    case 'inflate':
      return T('how.inflate');
    case 'text-chunk':
      return T('how.textChunk');
    case 'chunk':
      return T('how.chunk');
    case 'frame':
      return T('how.frame');
    case 'embedded-file':
      return T('how.embeddedFile');
    case 'carve:exact':
      return T('how.carveExact');
    case 'carve:truncated':
      return T('how.carveTruncated');
    case 'carve:guess':
      return T('how.carveGuess');
    case 'trailing':
      return T('how.trailing');
    default:
      return how;
  }
}

function statusText(n: Node): string {
  if (n.how === 'input') return T('status.input');
  if (n.confirmed) return T('status.confirmed');
  return n.kind === 'decoded' ? T('status.decoded') : T('status.candidate');
}

function noteOutput(n: ExtractNote, maxDepth: number): Output {
  const path = n.path;
  switch (n.code) {
    case 'depth':
      return { type: 'note', level: 'warn', text: T('note.depth', { path, depth: maxDepth }) };
    case 'nodes':
      return { type: 'note', level: 'warn', text: T('note.nodes', { path, max: MAX_NODES }) };
    case 'bytes':
      return {
        type: 'note',
        level: 'warn',
        text: T('note.bytes', { path, size: formatSize(MAX_BYTES) }),
      };
    case 'work':
      return { type: 'note', level: 'warn', text: T('note.work', { path }) };
    case 'encrypted':
      return { type: 'note', level: 'info', text: T('note.encrypted', { path }) };
    case 'pdf-failed':
      return {
        type: 'note',
        level: 'warn',
        text: T('note.pdfFailed', { path, message: n.detail ?? '' }),
      };
  }
}

/** A download name from the path under the input: "layers__pic.png__tEXt-Comment". */
function fileName(root: Node, n: Node, taken: Set<string>): string {
  const rest = n.path.slice(root.path.length + 1);
  const joined = rest.replace(/[\\/]+/g, '__');
  const base =
    [...joined]
      .map((ch) => (ch.charCodeAt(0) < 0x20 || ':*?"<>|'.includes(ch) ? '_' : ch))
      .join('') || 'file';
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}-${i}`;
  taken.add(name);
  return name;
}

function filesOutput(root: Node, nodes: Node[]): { out: Output | null; capped: boolean } {
  // Flagged nodes first: they are what the user came for.
  const ordered = [
    ...nodes.filter((n) => n.flags.length > 0),
    ...nodes.filter((n) => n.flags.length === 0),
  ];
  const taken = new Set<string>();
  const files: Extract<Output, { type: 'files' }>['files'] = [];
  let total = 0;
  let capped = false;
  for (const n of ordered) {
    if (files.length >= MAX_FILES || total + n.size > MAX_FILES_BYTES) {
      capped = true;
      break;
    }
    total += n.size;
    const note = `${formatName(n.format)} · ${howText(n.how)}`;
    const name = fileName(root, n, taken);
    files.push(
      n.size > BLOB_FROM
        ? { name, data: new Uint8Array(0), blob: new Blob([n.bytes as BlobPart]), note }
        : // slice(): a view would drag the whole input along when the result crosses a worker.
          { name, data: n.bytes.slice(), note },
    );
  }
  return {
    out: files.length > 0 ? { type: 'files', label: T('label.files'), files } : null,
    capped,
  };
}

export default defineTool({
  id: 'extract',
  name: 'Universal extractor',
  category: 'forensics',
  description:
    'Open a file layer by layer: ZIP, TAR, gzip, zlib, PDF attachments, PNG chunks and frames, files hidden by their magic bytes and encoded text, as one tree with the flags on top.',
  tags: [
    'binwalk',
    'extract',
    'recursive',
    'unpack',
    'matryoshka',
    'nested',
    'layers',
    'carve',
    'embedded',
    'appended',
    'polyglot',
    'foremost',
    'unzip',
    'cyberchef',
  ],
  input: 'file',
  placeholder: 'Drop any file: an archive, an image with something behind it, a PDF, a dump…',
  options: {
    depth: number('Depth', MAX_DEPTH, {
      min: 1,
      max: MAX_DEPTH,
      hint: 'How many levels below the file are opened (a ZIP in a PNG in a PDF is three).',
    }),
    carve: bool('Carve embedded files', true, {
      hint: 'Look for files hidden inside the data by their magic bytes, and for data after the end of a file.',
    }),
    decode: bool('Decode text', true, {
      hint: 'Try Base64, hex, URL encoding, gzip text and the other decoders on every text found, and follow what comes out.',
    }),
    size: number('Read at most (MiB)', DEFAULT_READ_MIB, {
      min: 1,
      max: 256,
      hint: 'The file is read into memory: a larger one is cut at this size.',
    }),
    writeup: bool('Copy-ready writeup (Markdown)', false, {
      hint: 'Add a Markdown "how I found it" report you can paste into a CTF writeup.',
    }),
    includeFlag: bool('Include the flag in the writeup', false, {
      hint: 'Off by default so the writeup can be shared without spoiling the flag.',
      showIf: (v) => v.writeup === true,
    }),
  },
  examples: [
    {
      label: 'ZIP > PNG > text chunk > Base64: four layers down',
      input: { sample: 'extract-nested.zip' },
      expect: 'FTF{extract_unwraps_layers}',
    },
    {
      label: 'Same file without decoding: it stops at the Base64 text',
      input: { sample: 'extract-nested.zip' },
      options: { decode: false },
      expect: 'tEXt-Comment',
    },
    {
      label: 'A ZIP glued behind a PNG',
      input: { sample: 'forensics-polyglot.png' },
      expect: 'flag{binwalk_found_me}',
    },
    {
      label: 'Archives inside archives',
      input: { sample: 'forensics-nested.zip' },
      expect: 'flag{matryoshka_archive}',
    },
  ],
  async run(input, { depth, carve, decode, size, writeup, includeFlag }) {
    if (input.size === 0) throw new ToolError(T('error.empty'));
    const cap = Math.max(1, Math.floor(size)) * MIB;
    const bytes = await input.read(0, cap);
    const result = await extract(bytes, {
      maxDepth: depth,
      carve,
      decode,
      name: input.name ? input.name.split(/[\\/]/).pop() : undefined,
    });
    const nodes = flatten(result.root);
    const rest = nodes.filter((x) => x.node !== result.root).map((x) => x.node);
    const out: Output[] = [];

    // ---- the verdict ----
    const flagged = nodes.filter((x) => x.node.flags.length > 0);
    if (result.flags.length > 0) {
      out.push({
        type: 'note',
        level: 'success',
        text: T('note.flags', { count: result.flags.length, list: result.flags.join(' · ') }),
      });
    } else if (rest.length > 0) {
      out.push({ type: 'note', level: 'info', text: T('note.noFlags') });
    } else {
      out.push({
        type: 'note',
        level: 'info',
        text: T('note.nothing', { size: formatSize(bytes.length) }),
      });
    }
    if (input.size > bytes.length) {
      out.push({
        type: 'note',
        level: 'warn',
        text: T('note.sizeCap', { read: formatSize(bytes.length), total: formatSize(input.size) }),
      });
    }
    for (const n of result.notes) out.push(noteOutput(n, depth));

    // ---- summary ----
    const counts = new Map<string, number>();
    for (const n of rest) counts.set(n.format, (counts.get(n.format) ?? 0) + 1);
    const formats = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 10)
      .map(([f, c]) => `${formatName(f)} × ${c}`)
      .join(', ');
    const summary: [string, string][] = [
      [T('kv.input'), `${formatName(result.root.format)} · ${formatSize(bytes.length)}`],
      [T('kv.nodes'), String(result.nodeCount)],
      [T('kv.depth'), String(Math.max(...nodes.map((x) => x.depth)))],
      [T('kv.formats'), formats || '-'],
      [T('kv.budget'), `${formatSize(result.byteBudgetSpent)} / ${formatSize(MAX_BYTES)}`],
      [T('kv.complete'), result.truncated ? T('value.no') : T('value.yes')],
    ];
    out.push({ type: 'kv', label: T('label.summary'), entries: summary });
    if (flagged.length > 0) {
      out.push({
        type: 'kv',
        label: T('label.flagsAt'),
        entries: flagged.flatMap((x) =>
          x.node.flags.map((f): [string, string] => [f, x.node.path]),
        ),
      });
    }

    // ---- the tree ----
    if (nodes.length > 1) {
      out.push({
        type: 'table',
        label: T('label.tree'),
        columns: [
          T('col.path'),
          T('col.format'),
          T('col.offset'),
          T('col.size'),
          T('col.status'),
          T('col.foundBy'),
          T('col.flag'),
        ],
        rows: nodes.map(({ node, depth: d }) => [
          `${'· '.repeat(d)}${node.name}`,
          formatName(node.format),
          node.offset ?? '-',
          node.size,
          statusText(node),
          howText(node.how),
          node.flags.join(' '),
        ]),
        highlight: nodes.flatMap(({ node }, i) =>
          node.kind !== 'root' && (node.confirmed || node.flags.length > 0) ? [i] : [],
        ),
      });
    }

    // ---- downloads and ways on ----
    const files = filesOutput(result.root, rest);
    if (files.out) out.push(files.out);
    if (files.capped) {
      out.push({ type: 'note', level: 'info', text: T('note.filesCapped', { max: MAX_FILES }) });
    }

    const tools = registeredTools();
    const autoDecode = tools.find((t) => t.id === 'auto-decode');
    if (autoDecode) {
      const texts = rest
        .filter(
          (n) =>
            (n.format === 'text' || n.format === 'data') &&
            n.flags.length === 0 &&
            n.size <= ACTION_TEXT &&
            n.children.length === 0,
        )
        .slice(0, MAX_ACTIONS);
      const actions = texts.flatMap((n) => {
        const text = utf8Decode(n.bytes);
        return /\S/.test(text) && !text.includes('�')
          ? [
              {
                label: T('action.autoDecode', { name: n.name, tool: toolName(autoDecode) }),
                options: {},
                open: { tool: autoDecode.id, text },
              },
            ]
          : [];
      });
      if (actions.length > 0) out.push({ type: 'actions', label: T('label.actions'), actions });
    }
    if (rest.some((n) => IMAGES.has(n.format))) {
      const names = ['lsb', 'image-analyzer']
        .map((id) => tools.find((t) => t.id === id))
        .flatMap((t) => (t ? [toolName(t)] : []));
      if (names.length > 0) {
        out.push({
          type: 'note',
          level: 'info',
          text: T('note.images', { tools: names.join(', ') }),
        });
      }
    }

    const howNote = T('note.how', {
      depth: MAX_DEPTH,
      nodes: MAX_NODES,
      size: formatSize(MAX_BYTES),
    });
    out.push({ type: 'note', level: 'info', text: howNote });

    if (writeup) {
      const sections = [
        {
          heading: T('label.summary'),
          body: kvTable(summary, [T('writeup.item'), T('writeup.value')]),
        },
        ...(flagged.length > 0
          ? [
              {
                heading: T('label.flagsAt'),
                body: mdTable(
                  [T('col.flag'), T('col.path')],
                  flagged.flatMap((x) =>
                    x.node.flags.map((f): [string, string] => [f, x.node.path]),
                  ),
                ),
              },
            ]
          : []),
        ...(nodes.length > 1
          ? [
              {
                heading: T('label.tree'),
                body: mdTable(
                  [
                    T('col.path'),
                    T('col.format'),
                    T('col.size'),
                    T('col.status'),
                    T('col.foundBy'),
                  ],
                  nodes.map(({ node, depth: d }) => [
                    `${'· '.repeat(d)}${node.name}`,
                    formatName(node.format),
                    node.size,
                    statusText(node),
                    howText(node.how),
                  ]),
                ),
              },
            ]
          : []),
        { heading: T('writeup.technique'), body: howNote },
      ];
      // buildWriteup masks one flag; several can be found, so mask them all here.
      const masked = includeFlag
        ? sections
        : sections.map((sec) => ({
            ...sec,
            body: result.flags.reduce((b, f) => b.split(f).join(FLAG_MASK), sec.body),
          }));
      out.push({
        type: 'text',
        label: T('label.writeup'),
        value: buildWriteup(masked, {
          title: T('writeup.title'),
          flag: result.flags[0],
          includeFlag,
          flagLabel: T('writeup.flag'),
        }),
      });
    }
    return out;
  },
});
