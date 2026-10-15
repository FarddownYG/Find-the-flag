/**
 * MP3 (MPEG audio) container checks: ID3 tags, junk before the first frame, every frame walked
 * by its header length, data between frames, the Xing / Info / VBRI header with the LAME
 * encoder string, and what follows the last frame. Only what sits next to the audio is looked at:
 * the compressed audio itself is never decoded, and a lossy file cannot carry sample LSB data.
 */
import { mpegFrame, type MpegFrame } from '../../core/audio-rate';
import { toolT } from '../../i18n/tool-text';
import { latin1Decode, u32be } from '../../lib/bytes';
import { addBlob, emptyAnalysis, merge, type Analysis } from './_audio-stego-found';
import { hasId3v2, id3v2Size, parseId3v1, parseId3v2 } from './_audio-stego-id3';

const T = toolT('audio-stego');

const MODES = ['stereo', 'jointStereo', 'dual', 'mono'] as const;

/**
 * Is there a run of real frames at `p`? `need` frames that follow each other with the same
 * version, layer and rate, or fewer when they reach the end of the audio. A stray 0xFFEx in
 * tag or picture bytes does not chain.
 */
function chainOk(b: Uint8Array, p: number, need: number, limit: number): boolean {
  let q = p;
  let n = 0;
  let key = '';
  while (n < need) {
    if (q + 4 > limit) return n >= 1;
    const f = mpegFrame(b, q);
    if (!f || (n > 0 && f.key !== key)) return false;
    key = f.key;
    q += f.length;
    n++;
    if (q > limit) return true; // the last frame is cut short
  }
  return true;
}

/** The first position at or after `from` where frames start, or -1. */
function findFrame(b: Uint8Array, from: number, limit: number, need: number): number {
  for (let p = from; p + 4 <= limit; p++) {
    if (b[p] === 0xff && (b[p + 1]! & 0xe0) === 0xe0 && chainOk(b, p, need, limit)) return p;
  }
  return -1;
}

/** Bytes of side information between the frame header and a Xing / Info header. */
const sideInfo = (f: MpegFrame): number =>
  f.version === 1 ? (f.channelMode === 3 ? 17 : 32) : f.channelMode === 3 ? 9 : 17;

function xingHeader(
  b: Uint8Array,
  at0: number,
  f: MpegFrame,
  out: Analysis,
): { frames: number | null } {
  const o = at0 + 4 + (f.crc ? 2 : 0) + sideInfo(f);
  const kind = latin1Decode(b.subarray(o, o + 4));
  const meta = (name: string, value: string) =>
    out.meta.push({ source: 'Xing / Info', name, value });
  if (kind === 'Xing' || kind === 'Info') {
    const flags = u32be(b, o + 4);
    let p = o + 8;
    let frames: number | null = null;
    meta(T('xing.type'), kind === 'Xing' ? T('xing.vbr') : T('xing.cbr'));
    if (flags & 1) {
      frames = u32be(b, p);
      meta(T('xing.frames'), String(frames));
      p += 4;
    }
    if (flags & 2) meta(T('xing.bytes'), String(u32be(b, p)));
    const encoder = latin1Decode(b.subarray(o + 120, o + 129));
    if (/^[\x20-\x7e]{4,9}$/.test(encoder)) meta(T('xing.encoder'), encoder.trimEnd());
    return { frames };
  }
  const vbri = at0 + 4 + 32;
  if (latin1Decode(b.subarray(vbri, vbri + 4)) === 'VBRI') {
    meta(T('xing.type'), 'VBRI');
    meta(T('xing.bytes'), String(u32be(b, vbri + 10)));
    meta(T('xing.frames'), String(u32be(b, vbri + 14)));
    return { frames: u32be(b, vbri + 14) };
  }
  return { frames: null };
}

export function analyzeMp3(b: Uint8Array): Analysis {
  const out = emptyAnalysis('MP3');
  let p = 0;
  while (hasId3v2(b, p)) {
    const tag = parseId3v2(b, p);
    if (tag) merge(out, tag);
    p += id3v2Size(b, p);
  }
  p = Math.min(p, b.length);
  const v1 = parseId3v1(b, b.length - 128);
  if (v1) merge(out, v1);
  const limit = v1 ? v1.rows[0]!.offset : b.length;

  const first = findFrame(b, p, limit, 3);
  if (first < 0) {
    out.notes.push({ level: 'warn', text: T('mp3.noFrames') });
    return out;
  }
  if (first > p) {
    const junk = b.subarray(p, first);
    out.rows.push({ offset: p, name: T('mp3.junkRow'), size: junk.length, what: T('mp3.junk') });
    addBlob(out, {
      where: T('where.beforeFrames'),
      offset: p,
      data: junk.slice(),
      name: 'mp3-before-first-frame.bin',
    });
  }

  // Walk the frames.
  const f0 = mpegFrame(b, first)!;
  let key = f0.key;
  let frames = 0;
  let samples = 0;
  let rate = f0.rate;
  const bitrates = new Set<number>();
  let q = first;
  let cut = 0;
  const gaps: { start: number; end: number }[] = [];
  while (q + 4 <= limit) {
    const f = mpegFrame(b, q);
    if (f && f.key === key) {
      frames++;
      samples += f.samples;
      if (bitrates.size < 64) bitrates.add(f.bitrate);
      if (q + f.length > limit) {
        cut = q + f.length - limit;
        q = limit;
        break;
      }
      q += f.length;
      continue;
    }
    const next = findFrame(b, q + 1, limit, 2);
    if (next < 0) break;
    gaps.push({ start: q, end: next });
    const nf = mpegFrame(b, next)!;
    if (nf.key !== key) {
      key = nf.key;
      rate = nf.rate;
    }
    q = next;
  }
  const audioEnd = q;

  const vbr = bitrates.size > 1;
  const kbps = [...bitrates].sort((x, y) => x - y).map((x) => x / 1000);
  out.summary.push(
    [T('kv.format'), T('mp3.format', { version: f0.version, layer: 'I'.repeat(f0.layer) })],
    [
      T('kv.audio'),
      T('mp3.audio', {
        rate: f0.rate,
        mode: T(`mp3.mode.${MODES[f0.channelMode]!}`),
        bitrate: vbr ? `${kbps[0]}–${kbps[kbps.length - 1]} (VBR)` : `${kbps[0]}`,
      }),
    ],
    [T('kv.frames'), T('mp3.frames', { count: frames, seconds: (samples / rate).toFixed(2) })],
  );
  out.rows.push({
    offset: first,
    name: T('mp3.framesRow'),
    size: audioEnd - first,
    what: T('mp3.framesWhat', { count: frames, gaps: gaps.length }),
  });

  const xing = xingHeader(b, first, f0, out);
  if (xing.frames !== null && Math.abs(xing.frames - (frames - 1)) > 2) {
    out.notes.push({
      level: 'info',
      text: T('mp3.xingMismatch', { announced: xing.frames, found: frames - 1 }),
    });
  }

  for (const g of gaps) {
    const data = b.subarray(g.start, g.end);
    out.rows.push({
      offset: g.start,
      name: T('mp3.gapRow'),
      size: data.length,
      what: T('mp3.gap'),
    });
    addBlob(out, {
      where: T('where.betweenFrames'),
      offset: g.start,
      data: data.slice(),
      name: `mp3-between-frames-${g.start}.bin`,
    });
  }
  if (cut) out.notes.push({ level: 'info', text: T('mp3.cut', { count: cut }) });

  // After the last frame: more tags, then whatever is left.
  let t = audioEnd;
  while (hasId3v2(b, t) && t < limit) {
    const tag = parseId3v2(b, t);
    if (tag) merge(out, tag);
    t += id3v2Size(b, t);
  }
  t = Math.min(t, limit);
  if (t < limit) {
    const tail = b.subarray(t, limit);
    out.rows.push({ offset: t, name: T('mp3.tailRow'), size: tail.length, what: T('mp3.tail') });
    addBlob(out, {
      where: T('where.afterFrames'),
      offset: t,
      data: tail.slice(),
      name: 'mp3-after-last-frame.bin',
    });
  }
  out.rows.sort((x, y) => x.offset - y.offset);
  return out;
}
