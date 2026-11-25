/**
 * Image detector for the analysis socle: decode the pixels exactly, then run the steganography
 * cores the tools already own (PNG text chunks, LSB planes and carrier zones, PVD, PIT, chi-square
 * and RS statistics) and report what they find as flat findings.
 *
 * Confidence rule: 'confirmed' only for a recovered flag (the stream decoded to prefix{...}), never
 * for a statistic. A recovered file signature is 'probable', statistics are 'probable' only when
 * two independent tests agree, and every weak hint is a 'candidate'. A clean image yields nothing
 * stronger than a candidate. Pure and deterministic: bytes in, findings out.
 */
import { latin1Decode } from '../lib/bytes';
import { chiSquare, channelSamples, rsAnalysis } from '../tools/stego/_steganalysis';
import { type LsbParams, extractBits, parseChannels } from '../tools/stego/_lsb-core';
import { classifyStream, FLAG_RE, type StreamHit } from '../tools/stego/_lsb-classify';
import {
  anomalyRows,
  rangeMask,
  rowRanges,
  strideHint,
  zonePixels,
} from '../tools/stego/_lsb-zones';
import {
  bitsToBytes,
  type Channel,
  extractBits as pvdBits,
  samplesOf,
  sequence,
  TABLES,
  type TableName,
  type Traversal,
} from '../tools/stego/_pvd';
import {
  type CodeTable,
  decode as pitDecode,
  type IndicatorMode,
  type PitSettings,
} from '../tools/stego/_pit';
import { parsePng, pngTexts } from '../tools/stego/_png';
import { decodeImageExact } from './decode-image';
import type { RgbaImage } from './types';
import type { Finding } from './analyze';

/** Bytes of each LSB combination read for classification (the same budget as the LSB tool). */
const LSB_BYTES = 8192;
/** Beyond this many pixels the brute-force scans are skipped (they would stall a worker). */
const MAX_PIXELS = 16_000_000;
/** Chi-square needs enough samples per channel to mean anything. */
const MIN_STAT_SAMPLES = 4096;
const CHI_PROBABLE = 0.95;
/** RS embedding-rate estimate above which the second test agrees with the chi-square one. */
const RS_AGREES = 0.1;

const CHANNEL_ORDERS = ['r', 'g', 'b', 'a', 'rgb', 'bgr', 'rgba', 'abgr'];
const PLANE_SETS = [[0], [1], [2], [3], [0, 1], [0, 1, 2], [0, 1, 2, 3]];
const ZONE_CHANNELS = ['rgb', 'r', 'g', 'b', 'bgr'];
const ZONE_PLANES = [[0], [0, 1]];
const MAX_ZONES = 4;

const textOf = (b: Uint8Array): string => latin1Decode(b);
const flagIn = (b: Uint8Array): string | undefined => FLAG_RE.exec(textOf(b))?.[0];

/** What a decoded stream is worth: a flag is proof, a file magic is strong, text is a hint. */
function fromStream(method: string, stream: Uint8Array, hit: StreamHit | null): Finding | null {
  if (!hit) return null;
  if (hit.kind === 'flag') {
    const flag = flagIn(stream);
    if (flag) return { kind: 'flag', confidence: 'confirmed', title: flag, detail: method, flag };
  }
  if (hit.kind === 'file' && hit.sig) {
    return {
      kind: `stego-${method.split(':')[0]}`,
      confidence: 'probable',
      title: `hidden ${hit.sig.id}`,
      detail: method,
    };
  }
  // Readable text or a length prefix after a clean decode: worth a look, not proof.
  if (
    (hit.kind === 'prefixed' || hit.kind === 'text' || hit.kind === 'inner') &&
    (hit.count ?? hit.length ?? 0) >= 16
  ) {
    return {
      kind: `stego-${method.split(':')[0]}`,
      confidence: 'candidate',
      title: `readable ${hit.kind}`,
      detail: method,
    };
  }
  return null;
}

// ---------- PNG text chunks ----------

function textChunkFindings(bytes: Uint8Array): Finding[] {
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50) return [];
  const parsed = parsePng(bytes);
  if (!parsed) return [];
  const texts = pngTexts(bytes, parsed.chunks);
  const out: Finding[] = [];
  // A flag can be split across several chunks (APNG frame notes): read them joined, in order,
  // from the chunk where the flag starts (so a preceding sentence is not glued onto the prefix).
  for (let i = 0; i < texts.length; i++) {
    const joined = texts
      .slice(i)
      .map((t) => t.text)
      .join('');
    const m = FLAG_RE.exec(joined);
    if (m && m.index === 0 && i + 1 < texts.length && !FLAG_RE.test(texts[i]!.text)) {
      out.push({
        kind: 'flag',
        confidence: 'confirmed',
        title: m[0],
        detail: 'png-text',
        flag: m[0],
      });
      return out;
    }
  }
  for (const t of texts) {
    const flag = FLAG_RE.exec(t.text)?.[0];
    if (flag)
      out.push({
        kind: 'flag',
        confidence: 'confirmed',
        title: flag,
        detail: `png-text:${t.keyword}`,
        flag,
      });
  }
  return out;
}

// ---------- LSB ----------

function lsbScan(img: RgbaImage): Finding[] {
  const opaque = (() => {
    for (let i = 3; i < img.data.length; i += 4) if (img.data[i] !== 255) return false;
    return true;
  })();
  const found: { tier: number; finding: Finding }[] = [];
  const tierOf = (f: Finding) =>
    f.confidence === 'confirmed' ? 2 : f.confidence === 'probable' ? 1 : 0;
  const keep = (f: Finding | null) => {
    if (f) found.push({ tier: tierOf(f), finding: f });
  };
  for (const chans of CHANNEL_ORDERS) {
    if (opaque && chans.includes('a')) continue;
    const channels = parseChannels(chans);
    for (const planes of PLANE_SETS) {
      for (const order of ['row', 'col'] as const) {
        for (const bitOrder of ['msb', 'lsb'] as const) {
          const params: LsbParams = { channels, planes, order, bitOrder };
          const stream = extractBits(img, params, LSB_BYTES);
          keep(
            fromStream(
              `lsb:${chans}/${planes.join('')}/${order}/${bitOrder}`,
              stream,
              classifyStream(stream),
            ),
          );
        }
      }
    }
  }
  const zone = zoneScan(img);
  for (const f of zone) keep(f);
  return best(found);
}

/** The carrier rows the entropy scan flags, read with every-other-pixel strides. */
function zoneScan(img: RgbaImage): Finding[] {
  const anomalies = anomalyRows(img);
  const ranges = rowRanges(anomalies);
  // Nearly every row flagged is a noisy picture, not a carrier zone.
  if (!ranges.length || anomalies.length * 2 > img.height) return [];
  const out: Finding[] = [];
  const top = anomalies.reduce((a, b) => (b.score > a.score ? b : a));
  const stride = strideHint(img, top.row);
  const steps = [...new Set([1, 2, stride?.step ?? 1])];
  const offsets = [...new Set([0, 1, stride?.offset ?? 0])];
  const masks = ranges
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_ZONES)
    .map((r) => rangeMask(img.height, r.from, r.to));
  let zoneFlagged = false;
  for (const mask of masks) {
    const pixels = zonePixels(img.width, img.height, 'row', mask);
    for (const chans of ZONE_CHANNELS) {
      const channels = parseChannels(chans);
      for (const planes of ZONE_PLANES) {
        for (const bitOrder of ['msb', 'lsb'] as const) {
          for (const step of steps) {
            for (const offset of offsets) {
              const params: LsbParams = {
                channels,
                planes,
                order: 'row',
                bitOrder,
                pixels,
                step,
                offset,
              };
              const stream = extractBits(img, params, LSB_BYTES);
              const f = fromStream(
                `lsb-zone:${chans}/${planes.join('')}/${bitOrder}/step${step}+${offset}`,
                stream,
                classifyStream(stream),
              );
              if (f) {
                out.push(f);
                zoneFlagged = true;
              }
            }
          }
        }
      }
    }
  }
  if (!zoneFlagged) {
    const rows = ranges.map((r) => (r.from === r.to ? `${r.from}` : `${r.from}-${r.to}`)).join(',');
    out.push({
      kind: 'stego-lsb-zone',
      confidence: 'candidate',
      title: 'low bits unusually busy on some rows',
      detail: `rows ${rows}`,
    });
  }
  return out;
}

/** Keep the strongest findings; several settings often decode the same payload. */
function best(found: { tier: number; finding: Finding }[]): Finding[] {
  const top = found.reduce((m, f) => Math.max(m, f.tier), -1);
  if (top < 0) return [];
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const { tier, finding } of found) {
    if (tier !== top) continue;
    const key = `${finding.kind}|${finding.flag ?? finding.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(finding);
    if (out.length >= 3) break;
  }
  return out;
}

// ---------- PVD ----------

const PVD_TABLES: TableName[] = ['wu-tsai', 'equal-16', 'equal-8'];
const PVD_TRAVERSALS: Traversal[] = ['row', 'serpentine', 'column', 'column-serpentine'];
const PVD_CHANNELS: Channel[] = ['gray', 'r', 'g', 'b', 'rgb'];
const PVD_PIXELS = 6000;
const PVD_BYTES = 1024;

function pvdScan(img: RgbaImage): Finding[] {
  const found: { tier: number; finding: Finding }[] = [];
  const n = Math.min(PVD_PIXELS, img.width * img.height);
  for (const traversal of PVD_TRAVERSALS) {
    const seq = sequence(img.width, img.height, traversal).subarray(0, n);
    for (const channel of PVD_CHANNELS) {
      const samples = samplesOf(img, channel, seq);
      for (const tableName of PVD_TABLES) {
        for (const overflow of [false, true]) {
          const bits = pvdBits(samples, { table: TABLES[tableName], overflow }, PVD_BYTES * 8);
          for (const msbFirst of [true, false]) {
            const stream = bitsToBytes(bits, msbFirst);
            const f = fromStream(
              `pvd:${tableName}/${traversal}/${channel}/${overflow ? 'overflow' : 'plain'}/${msbFirst ? 'msb' : 'lsb'}`,
              stream,
              classifyStream(stream),
            );
            if (f)
              found.push({
                tier: f.confidence === 'confirmed' ? 2 : f.confidence === 'probable' ? 1 : 0,
                finding: f,
              });
          }
        }
      }
    }
  }
  return best(found);
}

// ---------- PIT ----------

const PIT_INDICATORS: IndicatorMode[] = ['r', 'g', 'b', 'rotate'];
const PIT_TABLES: CodeTable[] = [
  ['none', 'c1', 'c2', 'c1c2'],
  ['none', 'c1', 'c2', 'c2c1'],
  ['none', 'c2', 'c1', 'c1c2'],
  ['none', 'c2', 'c1', 'c2c1'],
];
const PIT_HEADERS: { bytes: number; endian: 'be' | 'le' }[] = [
  { bytes: 8, endian: 'be' },
  { bytes: 4, endian: 'be' },
  { bytes: 8, endian: 'le' },
  { bytes: 4, endian: 'le' },
];
const PIT_STARTS: Pick<PitSettings, 'startMode' | 'startRow'>[] = [
  { startMode: 'after', startRow: 0 },
  { startMode: 'row', startRow: 0 },
  { startMode: 'row', startRow: 1 },
];
const PIT_PREVIEW = 96;

function pitScan(img: RgbaImage): Finding[] {
  const found: { tier: number; finding: Finding }[] = [];
  const total = img.width * img.height;
  for (const indicator of PIT_INDICATORS) {
    for (const codeTable of PIT_TABLES) {
      for (const bitsPerChannel of [2, 1]) {
        for (const bitOrder of ['msb', 'lsb'] as const) {
          for (const h of PIT_HEADERS) {
            for (const st of PIT_STARTS) {
              const s: PitSettings = {
                indicator,
                codeTable,
                bitsPerChannel,
                bitOrder,
                header: { ...h, atPixel: 0 },
                ...st,
              };
              const r = pitDecode(img, s, PIT_PREVIEW);
              // A header announcing more than the image can hold is noise, not a length.
              const room = Math.floor(((total - r.bodyStart) * 2 * bitsPerChannel) / 8);
              if (r.header < 1 || r.header > room) continue;
              const f = fromStream(
                `pit:${indicator}/${codeTable.join('-')}/${bitsPerChannel}/${bitOrder}/${h.bytes}${h.endian}/${st.startMode}${st.startRow}`,
                r.body,
                classifyStream(r.body),
              );
              if (f)
                found.push({
                  tier: f.confidence === 'confirmed' ? 2 : f.confidence === 'probable' ? 1 : 0,
                  finding: f,
                });
            }
          }
        }
      }
    }
  }
  return best(found);
}

// ---------- statistics ----------

function statisticFindings(img: RgbaImage): Finding[] {
  if (img.width * img.height * 1 < MIN_STAT_SAMPLES) return [];
  const rows: string[] = [];
  let agree = false;
  for (const channel of [0, 1, 2]) {
    const chi = chiSquare(channelSamples(img, channel));
    if (chi.p <= CHI_PROBABLE || chi.pairs < 20) continue;
    const rs = rsAnalysis(img, channel);
    rows.push(`${'rgb'[channel]}: chi2 p=${chi.p.toFixed(3)}, RS ${rs.estimate.toFixed(2)}`);
    if (rs.estimate >= RS_AGREES) agree = true;
  }
  if (!rows.length) return [];
  return [
    {
      kind: 'stego-statistics',
      // Two independent tests agreeing is strong evidence, not proof: never 'confirmed'.
      confidence: agree ? 'probable' : 'candidate',
      title: agree
        ? 'chi-square and RS point to LSB embedding'
        : 'chi-square points to LSB embedding',
      detail: rows.join('; '),
    },
  ];
}

// ---------- entry point ----------

export async function detectImage(bytes: Uint8Array, name?: string): Promise<Finding[]> {
  void name;
  const findings: Finding[] = [];
  findings.push(...textChunkFindings(bytes));

  let img: RgbaImage | null;
  try {
    img = decodeImageExact(bytes);
  } catch {
    return dedupe(findings);
  }
  if (!img) return dedupe(findings);
  if (img.width * img.height > MAX_PIXELS || img.width < 2 || img.height < 1)
    return dedupe(findings);

  findings.push(...lsbScan(img), ...pvdScan(img), ...pitScan(img), ...statisticFindings(img));
  return dedupe(findings);
}

/** One finding per recovered flag, keeping the first method that found it. */
function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const f of findings) {
    const key = f.flag ? `flag|${f.flag}` : `${f.kind}|${f.title}|${f.detail ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}
