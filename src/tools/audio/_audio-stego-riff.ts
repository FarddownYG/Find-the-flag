/**
 * WAV and AIFF container checks: every chunk listed, tags read (LIST/INFO, bext, XML, ID3, AIFF
 * text chunks), chunks the format does not define, padding chunks that are not empty, size fields
 * that disagree with the file, a partial sample frame at the end of the audio, and the bytes after
 * the last chunk.
 */
import { toolT } from '../../i18n/tool-text';
import { u16be, u32le } from '../../lib/bytes';
import {
  addBlob,
  at,
  bytesToText,
  cString,
  emptyAnalysis,
  fourCC,
  isZero,
  merge,
  oneLine,
  type Analysis,
} from './_audio-stego-found';
import { parseId3v2 } from './_audio-stego-id3';
import {
  isNoPcm,
  type Chunk,
  type ChunkFile,
  type NoPcm,
  type PcmLayout,
} from './_audio-stego-pcm';

const T = toolT('audio-stego');

/** Chunk ids with a description of their own: not reported as unknown. */
const KNOWN: Readonly<Record<string, string>> = {
  'fmt ': 'fmt',
  data: 'data',
  fact: 'fact',
  'cue ': 'cue',
  plst: 'plst',
  smpl: 'smpl',
  inst: 'inst',
  bext: 'bext',
  iXML: 'ixml',
  _PMX: 'xmp',
  PEAK: 'peak',
  levl: 'peak',
  JUNK: 'junk',
  junk: 'junk',
  'PAD ': 'pad',
  FLLR: 'pad',
  'id3 ': 'id3',
  'ID3 ': 'id3',
  LIST: 'list',
  COMM: 'comm',
  SSND: 'ssnd',
  MARK: 'mark',
  INST: 'inst',
  COMT: 'comt',
  NAME: 'name',
  AUTH: 'auth',
  '(c) ': 'copyright',
  ANNO: 'anno',
  FVER: 'fver',
  CHAN: 'chan',
  MIDI: 'midi',
  AESD: 'aesd',
};
const PADDING_CHUNKS = new Set(['JUNK', 'junk', 'PAD ', 'FLLR']);
const TEXT_CHUNKS = new Set(['NAME', 'AUTH', '(c) ', 'ANNO']);

/** "PCM 16-bit, mono, 8000 Hz", or the codec that has no sample layout here. */
export function describeFormat(pcm: PcmLayout | NoPcm): string {
  if (isNoPcm(pcm)) {
    if (pcm.why === 'codec') return T('pcm.codec', { codec: pcm.codec });
    if (pcm.why === 'layout') {
      return T('pcm.layout', { bits: pcm.bits, channels: pcm.channels });
    }
    return T(pcm.why === 'noFmt' ? 'pcm.noFmt' : 'pcm.noData');
  }
  const channels =
    pcm.channels === 1
      ? T('pcm.mono')
      : pcm.channels === 2
        ? T('pcm.stereo')
        : T('pcm.channels', { count: pcm.channels });
  return T('pcm.format', {
    sample: pcm.sample === 'float' ? T('pcm.float') : 'PCM',
    bits: pcm.bits,
    channels,
    rate: pcm.rate,
  });
}

const seconds = (frames: number, rate: number): string => (rate ? (frames / rate).toFixed(2) : '?');

function listChunk(b: Uint8Array, c: Chunk, out: Analysis): string {
  const type = fourCC(b, c.start);
  const meta = (source: string, name: string, value: string) =>
    out.meta.push({ source, name, value: oneLine(value, 300) });
  let p = c.start + 4;
  let count = 0;
  while (p + 8 <= c.end) {
    const id = fourCC(b, p);
    const size = u32le(b, p + 4);
    if (p + 8 + size > c.end || !/^[A-Za-z0-9 ]{4}$/.test(id)) break;
    const body = b.subarray(p + 8, p + 8 + size);
    if (type === 'INFO') meta('LIST/INFO', id, cString(body));
    else if (type === 'adtl' && (id === 'labl' || id === 'note') && size >= 4) {
      meta('LIST/adtl', `${id} ${u32le(body, 0)}`, cString(body.subarray(4)));
    } else if (type === 'adtl' && id === 'ltxt' && size > 20) {
      meta('LIST/adtl', `${id} ${u32le(body, 0)}`, cString(body.subarray(20)));
    }
    count++;
    p += 8 + size + (size & 1);
  }
  if (p < c.end - 1 && !isZero(b.subarray(p, c.end))) {
    addBlob(out, {
      where: T('where.chunk', { id: `LIST ${type}` }),
      offset: p,
      data: b.slice(p, c.end),
      name: 'wav-list-extra.bin',
    });
  }
  return T('chunk.list', { type, count });
}

function bextChunk(b: Uint8Array, c: Chunk, out: Analysis): void {
  const body = b.subarray(c.start, c.end);
  const meta = (name: string, value: string) => {
    if (value) out.meta.push({ source: 'bext', name, value: oneLine(value, 500) });
  };
  meta('description', cString(body.subarray(0, 256)));
  meta('originator', cString(body.subarray(256, 288)));
  meta('reference', cString(body.subarray(288, 320)));
  meta('date', cString(body.subarray(320, 330)));
  meta('time', cString(body.subarray(330, 338)));
  if (body.length > 602) meta('coding history', cString(body.subarray(602)));
}

function commentsChunk(b: Uint8Array, c: Chunk, out: Analysis): void {
  let p = c.start + 2;
  const n = c.end - c.start >= 2 ? u16be(b, c.start) : 0;
  for (let i = 0; i < n && p + 8 <= c.end; i++) {
    const len = u16be(b, p + 6);
    out.meta.push({
      source: 'AIFF COMT',
      name: String(i + 1),
      value: oneLine(
        bytesToText(b.subarray(p + 8, Math.min(c.end, p + 8 + len))).replace(/\0+$/, ''),
        300,
      ),
    });
    p += 8 + len + (len & 1);
  }
}

export function analyzeChunks(b: Uint8Array, file: ChunkFile, pcm: PcmLayout | NoPcm): Analysis {
  const wav = file.kind === 'wav';
  const out = emptyAnalysis(wav ? 'WAV' : file.form === 'AIFC' ? 'AIFF-C' : 'AIFF');
  out.summary.push([T('kv.format'), `${out.format} · ${describeFormat(pcm)}`]);
  if (!isNoPcm(pcm)) {
    out.summary.push([
      T('kv.frames'),
      T('pcm.frames', { count: pcm.frames, seconds: seconds(pcm.frames, pcm.rate) }),
    ]);
  }

  let dataSeen = false;
  for (const c of file.chunks) {
    const id = c.id;
    const name = KNOWN[id];
    let what = name ? T(`chunk.${name}`) : T('chunk.unknown');
    if (id === 'fmt ' || id === 'COMM') what = `${what}: ${describeFormat(pcm)}`;
    if ((id === 'data' || id === 'SSND') && !isNoPcm(pcm)) {
      what = T('chunk.dataWhat', { frames: pcm.frames, seconds: seconds(pcm.frames, pcm.rate) });
    }
    if (c.offset >= file.declaredEnd) what = `${what} · ${T('chunk.outside')}`;
    if (c.truncated) {
      what = `${what} · ${T('chunk.truncated', { announced: c.size, present: c.end - c.start })}`;
    }

    if (id === 'LIST' && c.end - c.start >= 4) what = listChunk(b, c, out);
    else if (id === 'bext') bextChunk(b, c, out);
    else if (id === 'iXML' || id === '_PMX') {
      out.meta.push({
        source: id === 'iXML' ? 'iXML' : 'XMP',
        name: 'xml',
        value: oneLine(bytesToText(b.subarray(c.start, c.end)), 1000),
      });
    } else if (id === 'id3 ' || id === 'ID3 ') {
      const tag = parseId3v2(b.subarray(c.start, c.end), 0, c.start);
      if (tag) merge(out, { meta: tag.meta, payloads: tag.payloads, notes: tag.notes });
    } else if (TEXT_CHUNKS.has(id)) {
      out.meta.push({
        source: 'AIFF',
        name: id.trim(),
        value: oneLine(bytesToText(b.subarray(c.start, c.end)), 300),
      });
    } else if (id === 'COMT') commentsChunk(b, c, out);
    else if (PADDING_CHUNKS.has(id)) {
      if (!isZero(b.subarray(c.start, c.end))) {
        addBlob(out, {
          where: T('where.chunk', { id: id.trim() }),
          offset: c.start,
          data: b.slice(c.start, c.end),
          name: `chunk-${id.trim()}.bin`,
        });
      }
    } else if (id === 'data' || id === 'SSND') {
      if (dataSeen) {
        addBlob(out, {
          where: T('where.chunk', { id }),
          offset: c.start,
          data: b.slice(c.start, c.end),
          name: `chunk-${id}-2.bin`,
        });
        out.notes.push({ level: 'warn', text: T('riff.secondData', { id, offset: at(c.offset) }) });
      }
      dataSeen = true;
    } else if (!name) {
      addBlob(out, {
        where: T('where.chunk', { id: id.trim() }),
        offset: c.start,
        data: b.slice(c.start, c.end),
        name: `chunk-${id.trim().replace(/[^A-Za-z0-9_-]/g, '_')}.bin`,
      });
    }
    // The pad byte after an odd-sized chunk should be zero.
    if (c.size & 1 && !c.truncated && c.end < b.length && b[c.end] !== 0) {
      out.notes.push({
        level: 'info',
        text: T('riff.padByte', {
          id: id.trim(),
          value: b[c.end]!.toString(16).padStart(2, '0'),
          offset: at(c.end),
        }),
      });
    }
    out.rows.push({ offset: c.offset, name: id.trim(), size: 8 + c.size, what });
  }

  if (!isNoPcm(pcm)) {
    if (pcm.truncated) {
      const data = file.chunks.find((c) => c.id === (wav ? 'data' : 'SSND'));
      if (data) {
        out.notes.push({
          level: 'info',
          text: T('riff.dataTruncated', { announced: data.size, present: data.end - data.start }),
        });
      }
    }
    if (pcm.leftover > 0) {
      out.notes.push({
        level: 'info',
        text: T('riff.leftover', { count: pcm.leftover, size: pcm.bytes * pcm.channels }),
      });
      const bytes = b.slice(pcm.end - pcm.leftover, pcm.end);
      if (!isZero(bytes)) {
        addBlob(out, {
          where: T('where.dataLeftover'),
          offset: pcm.end - pcm.leftover,
          data: bytes,
          name: 'audio-partial-frame.bin',
        });
      }
    }
    if (pcm.ssndOffset > 0) {
      const ssnd = file.chunks.find((c) => c.id === 'SSND');
      if (ssnd) {
        const skipped = b.slice(
          ssnd.start + 8,
          Math.min(ssnd.end, ssnd.start + 8 + pcm.ssndOffset),
        );
        if (!isZero(skipped)) {
          addBlob(out, {
            where: T('where.ssndOffset'),
            offset: ssnd.start + 8,
            data: skipped,
            name: 'aiff-ssnd-offset.bin',
          });
        }
      }
    }
  }

  const declared = file.declaredEnd;
  if (declared < b.length - 1) {
    out.notes.push({
      level: 'warn',
      text: T('riff.sizeShort', {
        kind: wav ? 'RIFF' : 'FORM',
        declared,
        actual: b.length,
        extra: b.length - declared,
      }),
    });
  } else if (declared > b.length + 1) {
    out.notes.push({
      level: 'info',
      text: T('riff.sizeLong', { kind: wav ? 'RIFF' : 'FORM', declared, actual: b.length }),
    });
  }
  if (file.stop < b.length) {
    const tail = b.slice(file.stop);
    out.rows.push({
      offset: file.stop,
      name: T('riff.tailRow'),
      size: tail.length,
      what: T('riff.tail'),
    });
    addBlob(out, {
      where: T('where.afterChunks'),
      offset: file.stop,
      data: tail,
      name: wav ? 'wav-after-data.bin' : 'aiff-trailing.bin',
    });
  }
  return out;
}
