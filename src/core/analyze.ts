/**
 * The analysis socle: one call that tells what a file is and what it hides. Seed version: it wires
 * the existing pieces (signature identification, the recursive extractor) into one flat list of
 * findings plus a checklist of what was checked. Later lots add anomaly detection on top.
 *
 * Pure and deterministic: bytes in, result out, no clock and no randomness. Language-free: findings
 * carry stable codes (`kind`, `confidence`); the UI turns them into words.
 */
import { identify } from '../lib/signatures';
import { extract, flatten, type Node } from '../tools/forensics/_extract';

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

  return { findings, checklist, format };
}
