import { ToolError } from './errors';
import { t } from '../i18n';
import { u16le, u32le } from '../lib/bytes';
import { FALLBACK_RATE, probeSampleRate, usableContextRate, type RateSource } from './audio-rate';

export interface DecodedAudio {
  sampleRate: number;
  channels: Float32Array[];
  /**
   * Where `sampleRate` comes from: 'file' = the container header (WAV, or probed before the
   * browser decoded without resampling), 'decoder' = whatever the browser produced, which may
   * have been resampled because the file's own rate could not be read.
   */
  rateSource?: RateSource;
  /** Opus only: rate of the original recording (the decoded rate is always 48000 Hz). */
  originalRate?: number;
}

/** Pure WAV (RIFF) decoder: PCM 8/16/24/32-bit and IEEE float 32/64. Returns null if not WAV. */
export function decodeWav(b: Uint8Array): DecodedAudio | null {
  const isRiff = b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46;
  const isWave = b[8] === 0x57 && b[9] === 0x41 && b[10] === 0x56 && b[11] === 0x45;
  if (!isRiff || !isWave) return null;
  let p = 12;
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  while (p + 8 <= b.length) {
    const id = String.fromCharCode(b[p]!, b[p + 1]!, b[p + 2]!, b[p + 3]!);
    const size = u32le(b, p + 4);
    const body = p + 8;
    if (id === 'fmt ') {
      let format = u16le(b, body);
      if (format === 0xfffe && size >= 26) format = u16le(b, body + 24); // WAVE_FORMAT_EXTENSIBLE
      fmt = {
        format,
        channels: u16le(b, body + 2),
        rate: u32le(b, body + 4),
        bits: u16le(b, body + 14),
      };
    } else if (id === 'data') {
      if (!fmt) throw new ToolError(t('core.wav.dataBeforeFmt'));
      const end = Math.min(b.length, body + size);
      return pcmToFloat(b.subarray(body, end), fmt);
    }
    p = body + size + (size & 1);
  }
  throw new ToolError(t('core.wav.noData'));
}

function pcmToFloat(
  d: Uint8Array,
  f: { format: number; channels: number; rate: number; bits: number },
): DecodedAudio {
  const bytesPer = f.bits / 8;
  if (!f.channels || !Number.isInteger(bytesPer) || bytesPer < 1) {
    throw new ToolError(t('core.wav.layout', { bits: f.bits, channels: f.channels }));
  }
  const frames = Math.floor(d.length / (bytesPer * f.channels));
  const channels = Array.from({ length: f.channels }, () => new Float32Array(frames));
  const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < f.channels; c++) {
      const o = (i * f.channels + c) * bytesPer;
      let v: number;
      if (f.format === 3) v = bytesPer === 4 ? view.getFloat32(o, true) : view.getFloat64(o, true);
      else if (bytesPer === 1) v = (d[o]! - 128) / 128;
      else if (bytesPer === 2) v = view.getInt16(o, true) / 32768;
      else if (bytesPer === 3)
        v = (((d[o]! | (d[o + 1]! << 8) | (d[o + 2]! << 16)) << 8) >> 8) / 8388608;
      else v = view.getInt32(o, true) / 2147483648;
      channels[c]![i] = v;
    }
  }
  return { sampleRate: f.rate, channels, rateSource: 'file' };
}

/** A Web Audio context at `rate`, or null when the browser refuses that rate. */
function contextAt(Ctx: typeof OfflineAudioContext, rate: number): OfflineAudioContext | null {
  if (!usableContextRate(rate)) return null;
  try {
    return new Ctx(1, 1, rate);
  } catch {
    return null; // e.g. Firefox does not accept rates below 8000 Hz
  }
}

/**
 * Browser-only fallback (MP3, OGG, FLAC, AAC, ...). The file's own rate is read from its header
 * first and the decoder is created at that rate: Web Audio resamples to the rate of its
 * context, so a fixed 44100 Hz context would turn a 22050 Hz MP3 into a fake 44100 Hz one.
 */
export async function decodeAudioInBrowser(bytes: Uint8Array): Promise<DecodedAudio> {
  const Ctx = globalThis.OfflineAudioContext;
  if (!Ctx) throw new ToolError(t('core.audio.unavailable'));
  const probe = probeSampleRate(bytes);
  const exact = probe ? contextAt(Ctx, probe.decodeRate) : null;
  const ctx = exact ?? contextAt(Ctx, FALLBACK_RATE);
  if (!ctx) throw new ToolError(t('core.audio.unavailable'));
  let buf: AudioBuffer;
  try {
    buf = await ctx.decodeAudioData(bytes.slice().buffer);
  } catch {
    throw new ToolError(t('core.audio.undecodable'));
  }
  return {
    sampleRate: buf.sampleRate,
    channels: Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i)),
    // 'file' only when the header was read and the decoder really ran at that rate.
    rateSource: exact && probe && buf.sampleRate === probe.decodeRate ? 'file' : 'decoder',
    ...(probe?.originalRate ? { originalRate: probe.originalRate } : {}),
  };
}
