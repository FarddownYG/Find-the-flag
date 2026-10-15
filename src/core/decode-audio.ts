import { ToolError } from './errors';
import { t } from '../i18n';
import { FALLBACK_RATE, probeSampleRate, usableContextRate, type RateSource } from './audio-rate';
import { decodeSamples, sampleBytes, scanWav } from './wav';

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
  const wav = scanWav(b);
  if (!wav) return null;
  if (!wav.data) throw new ToolError(t('core.wav.noData'));
  if (!wav.fmt) throw new ToolError(t('core.wav.dataBeforeFmt'));
  const f = wav.fmt;
  if (!f.channels || !sampleBytes(f)) {
    throw new ToolError(t('core.wav.layout', { bits: f.bits, channels: f.channels }));
  }
  const data = b.subarray(wav.data[0], wav.data[1]);
  return { sampleRate: f.rate, channels: decodeSamples(data, f), rateSource: 'file' };
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
 * Web Audio exists in the page only, not in workers.
 */
export async function decodeAudioInBrowser(bytes: Uint8Array): Promise<DecodedAudio> {
  return decodeBufferInBrowser(bytes, bytes.slice().buffer);
}

/**
 * Same, handing `buffer` (the same bytes as `head`, or a copy) to the decoder, which detaches
 * it: no copy is made here. `head` is only read for the rate.
 */
export async function decodeBufferInBrowser(
  head: Uint8Array,
  buffer: ArrayBuffer,
): Promise<DecodedAudio> {
  const Ctx = globalThis.OfflineAudioContext;
  if (!Ctx) throw new ToolError(t('core.audio.unavailable'));
  const probe = probeSampleRate(head);
  const exact = probe ? contextAt(Ctx, probe.decodeRate) : null;
  const ctx = exact ?? contextAt(Ctx, FALLBACK_RATE);
  if (!ctx) throw new ToolError(t('core.audio.unavailable'));
  let buf: AudioBuffer;
  try {
    buf = await ctx.decodeAudioData(buffer);
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
