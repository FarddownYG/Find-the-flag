/**
 * Audio detector for the analysis socle: read the raw PCM samples of a WAV (never the decoded
 * floats, which would hide the very bits this is about) and run the LSB search the audio-stego
 * tool owns: the usual plane / channel / bit-order settings, plus a second pass around the place
 * where a silent plane starts to change.
 *
 * Confidence rule: 'confirmed' only for a recovered flag (the stream decoded to prefix{...}),
 * never for a statistic and never because the file is a clean WAV. A recovered file signature is
 * 'probable'; readable text (with or without a length header) is only a 'candidate'. A clean WAV
 * yields nothing stronger than a candidate. Pure and deterministic: bytes in, findings out.
 */
import { latin1Decode } from '../lib/bytes';
import { aroundOnset, rankHits, scanLsb, type ScanHit } from '../tools/audio/_audio-stego-lsb';
import {
  firstChange,
  findOnset,
  isNoPcm,
  planeStats,
  readPcm,
  walkChunks,
  type LsbSpec,
  type PcmLayout,
} from '../tools/audio/_audio-stego-pcm';
import { FLAG_RE } from '../tools/stego/_lsb-classify';
import type { Finding } from './analyze';

/** A readable run shorter than this is not worth a candidate (random bits reach it often). */
const MIN_CANDIDATE = 16;
/** At most this many non-flag findings are reported. */
const MAX_WEAK = 3;

/** Human-readable settings, language-free: "planes 0 · all channels · msb". */
function settings(spec: LsbSpec, p: PcmLayout): string {
  const channel =
    spec.channel === null ? (p.channels > 1 ? 'all channels' : 'mono') : `channel ${spec.channel}`;
  const unit = spec.unit === 'byte' ? 'byte-wise · ' : '';
  return `lsb planes ${spec.planes.join(',')} · ${channel} · ${unit}${spec.bitOrder} · offset ${spec.offset}`;
}

/** One hit per way of reading (neighbouring start positions all see the same data). */
function distinctHits(hits: ScanHit[]): ScanHit[] {
  const seen = new Set<string>();
  return rankHits(hits).filter((h) => {
    const key = [h.spec.channel, h.spec.unit, h.spec.bitOrder, h.spec.planes.join()].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function fromHit(h: ScanHit, p: PcmLayout): Finding | null {
  const { finding } = h;
  const hit = finding.hit;
  if (!hit) return null;
  const method = settings(h.spec, p);
  const size = finding.header ? finding.header.length : finding.payload.length;
  if (hit.kind === 'flag') {
    const flag = FLAG_RE.exec(latin1Decode(finding.payload))?.[0];
    if (flag) {
      // The flag pattern alone is weak proof over thousands of scanned bytes: audio-lab-stereo.wav
      // gives a random 32-bit number that fits as a length, and a pattern match 3 KB into the
      // 'payload'. It is decisive only when the decoded payload (or stream) starts with the flag.
      const decisive = hit.flagAt === 0;
      return {
        kind: 'flag',
        confidence: decisive ? 'confirmed' : 'probable',
        title: flag,
        detail: method,
        flag,
        size,
      };
    }
  }
  if (hit.kind === 'file' && hit.sig) {
    return {
      kind: 'stego-audio-lsb',
      confidence: 'probable',
      title: `hidden ${hit.sig.id}`,
      detail: method,
      size,
    };
  }
  const count = hit.count ?? hit.length ?? 0;
  if (hit.kind !== 'flag' && hit.kind !== 'file' && count >= MIN_CANDIDATE) {
    return {
      kind: 'stego-audio-lsb',
      confidence: 'candidate',
      title: `readable ${hit.kind}`,
      detail: method,
      size,
    };
  }
  return null;
}

export async function detectAudio(bytes: Uint8Array, _name?: string): Promise<Finding[]> {
  const file = walkChunks(bytes);
  if (!file || file.kind !== 'wav') return [];
  const pcm = readPcm(bytes, file);
  if (isNoPcm(pcm) || pcm.frames === 0) return [];

  let hits = scanLsb(bytes, pcm).hits;
  // A payload written into digital silence starts a few bits before the first bit that is not.
  if (hits[0] === undefined || hits[0].finding.tier < 4) {
    const start = findOnset(planeStats(bytes, pcm));
    if (start) {
      const frame = firstChange(bytes, pcm, start);
      const more = scanLsb(bytes, pcm, aroundOnset(pcm, frame, start.channel)).hits;
      hits = [...hits, ...more];
    }
  }

  const out: Finding[] = [];
  const flags = new Set<string>();
  let weak = 0;
  for (const h of distinctHits(hits)) {
    const f = fromHit(h, pcm);
    if (!f) continue;
    if (f.flag !== undefined) {
      if (flags.has(f.flag)) continue;
      flags.add(f.flag);
    } else if (weak++ >= MAX_WEAK) continue;
    out.push({ ...f, offset: pcm.start });
  }
  return out;
}
