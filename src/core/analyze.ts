/**
 * The analysis socle: one call that tells what a file is and what it hides. It identifies the
 * format, runs the recursive extractor, builds a map of the byte ranges the parsers explained (the
 * extractor's nodes, the container's own end, the MP4 sample tables), scans what is left for
 * anomalies (encrypted regions, data after the end, unreferenced entropy), then dispatches by
 * format and modality to the specialised detectors (image, audio, text, binary, crypto). The
 * findings are merged, deduplicated and ranked confirmed > probable > candidate; the checklist
 * always lists every check performed, so "nothing found" is never a bare answer.
 *
 * Pure and deterministic: bytes in, result out, no clock and no randomness. Language-free: findings
 * carry stable codes (`kind`, `confidence`); the UI turns them into words.
 */
import { printableRatio } from '../lib/bytes';
import { identify } from '../lib/signatures';
import { type CoveredRange, scanAnomalies } from '../tools/forensics/_anomaly';
import { extract, flatten, type Node } from '../tools/forensics/_extract';
import { parseMp4 } from '../tools/forensics/_mp4';
import { carveAll } from '../tools/forensics/carve';
import { detectAudio } from './_analyze-audio';
import { detectBinary } from './_analyze-binary';
import { detectCrypto } from './_analyze-crypto';
import { detectImage } from './_analyze-image';
import { detectText } from './_analyze-text';
import { analyse } from '../tools/encoding/_decoders';

export type Confidence = 'confirmed' | 'probable' | 'candidate';

export interface Finding {
  /** What was found, as a code: 'carved', 'container', 'embedded', 'decoded', 'flag'... */
  kind: string;
  confidence: Confidence;
  title: string;
  detail?: string;
  /** Offset inside the analysed input's parent node, when the finding is a slice of it. */
  offset?: number;
  size?: number;
  /** The flag text, for a decoded flag. */
  flag?: string;
}

export interface AnalysisResult {
  findings: Finding[];
  /** What was checked, in order (stable codes, not sentences). */
  checklist: string[];
  /** Signature id of the input ('png', 'zip'...), when identified. */
  format?: string;
}

function describe(node: Node): string {
  return `${node.path} (${node.format}, ${node.how})`;
}

function childFinding(node: Node): Finding {
  return {
    kind: node.kind,
    confidence: node.confirmed ? 'confirmed' : 'candidate',
    title: describe(node),
    detail: node.how,
    offset: node.offset,
    size: node.size,
  };
}

/** Inputs above this are not scanned by the heavy passes (anomaly map, detectors). */
const MAX_SCAN_BYTES = 64 * 1024 * 1024;
/** The brute-force detectors read at most this much; bigger inputs only get the cheap passes. */
const MAX_DETECT_BYTES = 32 * 1024 * 1024;
/** Bytes sampled to decide whether an input is text. */
const TEXT_SAMPLE = 4096;

const IMAGE_FORMATS = new Set(['png', 'jpeg', 'gif', 'bmp', 'webp', 'ico']);
const AUDIO_FORMATS = new Set(['wav']);
const EXECUTABLE_FORMATS = new Set(['elf', 'pe', 'macho', 'macho64']);
/** Formats with a dedicated structure that no raw-code or key search should be run on. */
const STRUCTURED_FORMATS = new Set([
  ...IMAGE_FORMATS,
  ...AUDIO_FORMATS,
  'mp3-id3',
  'pdf',
  'mp4',
  'zip',
  'sqlite',
  'pcap',
  'pcapng',
  'iso',
  'fat',
  'svg',
]);

const RANK: Record<Confidence, number> = { confirmed: 0, probable: 1, candidate: 2 };

/**
 * The byte ranges the parsers explained, for the anomaly scan. Returns null when nothing sound can
 * be said about the layout (a movie we cannot account for fully): the anomaly scan is then skipped
 * rather than guessing.
 */
function coveredMap(
  bytes: Uint8Array,
  format: string | undefined,
  tree: { root: Node },
  checklist: string[],
): CoveredRange[] | null {
  const covered: CoveredRange[] = [];

  if (format === 'mp4') {
    const mp4 = parseMp4(bytes);
    if (!mp4) {
      checklist.push('mp4-sample-tables-unparsed');
      return null;
    }
    checklist.push('mp4-sample-tables');
    // Everything that is not an unreferenced stretch is explained: boxes and referenced samples.
    let at = 0;
    for (const u of mp4.unreferenced) {
      if (u.start > at) covered.push({ start: at, end: u.start, label: 'mp4' });
      at = Math.max(at, u.end);
    }
    if (at < bytes.length) covered.push({ start: at, end: bytes.length, label: 'mp4' });
  } else if (format) {
    // The container that starts at offset 0: explained up to its own end when that end is exact,
    // otherwise (end only guessed) the whole file is treated as explained, never over-claiming.
    const container = carveAll(bytes, {
      container: true,
      nested: false,
      only: new Set(),
    }).container;
    if (container) {
      covered.push({
        start: 0,
        end: container.exact ? container.end : bytes.length,
        label: container.sig.id,
      });
    }
  }

  // Files the extractor carved out of the input and proved whole (their offset is in the input).
  for (const child of tree.root.children) {
    if (child.confirmed && child.offset !== undefined && child.kind === 'carved') {
      covered.push({
        start: child.offset,
        end: child.offset + child.size,
        label: `${child.format} (${child.how})`,
      });
    }
  }
  return covered;
}

type Detector = (bytes: Uint8Array, name?: string) => Promise<Finding[]>;

function pickDetectors(
  format: string | undefined,
  textLike: boolean,
): { id: string; run: Detector }[] {
  const out: { id: string; run: Detector }[] = [];
  if (textLike) {
    out.push({ id: 'text', run: detectText });
    return out;
  }
  if (!format || IMAGE_FORMATS.has(format)) out.push({ id: 'image', run: detectImage });
  if (format && AUDIO_FORMATS.has(format)) out.push({ id: 'audio', run: detectAudio });
  if (!format || EXECUTABLE_FORMATS.has(format)) out.push({ id: 'binary', run: detectBinary });
  if (!format || !STRUCTURED_FORMATS.has(format)) out.push({ id: 'crypto', run: detectCrypto });
  return out;
}

/** Same finding seen twice (same flag, or same kind over the same span): keep the stronger one. */
function dedupe(findings: Finding[]): Finding[] {
  const best = new Map<string, Finding>();
  for (const f of findings) {
    const key = f.flag
      ? `flag:${f.flag}`
      : `${f.kind}:${f.offset ?? ''}:${f.size ?? ''}:${f.offset === undefined ? f.title : ''}`;
    const prev = best.get(key);
    if (!prev || RANK[f.confidence] < RANK[prev.confidence]) best.set(key, f);
  }
  return [...best.values()];
}

export async function analyze(bytes: Uint8Array, name?: string): Promise<AnalysisResult> {
  const findings: Finding[] = [];
  const checklist: string[] = [];

  const sig = identify(bytes)[0];
  const format = sig?.id;
  checklist.push(format ? `format-identified:${format}` : 'format-unknown');

  const tree = await extract(bytes, { name });
  checklist.push('structure-parsed', 'carving-run', 'chain-decode-run');

  for (const { node } of flatten(tree.root)) {
    if (node.kind !== 'root') findings.push(childFinding(node));
    for (const flag of node.flags) {
      findings.push({
        kind: 'flag',
        confidence: 'confirmed',
        title: flag,
        detail: node.path,
        offset: node.offset,
        size: node.size,
        flag,
      });
    }
  }
  if (tree.truncated) checklist.push('extraction-truncated');

  // Anomalies: what no parser accounted for.
  if (bytes.length > MAX_SCAN_BYTES) {
    checklist.push('anomaly-scan-skipped:too-large');
  } else {
    const covered = coveredMap(bytes, format, tree, checklist);
    if (covered) {
      findings.push(...scanAnomalies(bytes, covered));
      checklist.push('structure-map-built', 'anomaly-scan-run');
    } else {
      checklist.push('anomaly-scan-skipped:layout-unknown');
    }
  }

  // Specialised detectors, by format and modality. "Text" is ASCII-printable OR valid UTF-8 with
  // few control chars — so Unicode-carried stego (homoglyphs, special spaces) still reaches the
  // text detectors instead of being mistaken for binary.
  const head = bytes.subarray(0, TEXT_SAMPLE);
  const textLike = printableRatio(head) >= 0.9 || analyse(head).textLike;
  if (bytes.length > MAX_DETECT_BYTES) {
    checklist.push('detectors-skipped:too-large');
  } else {
    for (const { id, run } of pickDetectors(format, textLike)) {
      try {
        findings.push(...(await run(bytes, name)));
        checklist.push(`detector-run:${id}`);
      } catch {
        checklist.push(`detector-failed:${id}`);
      }
    }
  }

  const merged = dedupe(findings).sort((a, b) => RANK[a.confidence] - RANK[b.confidence]);
  return { findings: merged, checklist, format };
}
