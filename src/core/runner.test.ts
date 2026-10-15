import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { concatBytes } from '../lib/bytes';
import { CancelledError, Runner, type WorkerLike } from './runner';
import {
  audioFile,
  exampleToRaw,
  prepareInput,
  resolveExampleOptions,
  type AudioFile,
} from './prepare';
import { defaultOptions, TOOLS } from './registry';
import { createWorkerHandler, type RunResponse, type WorkerRequest } from './worker-handler';
import type { AudioInput, Output } from './types';

/**
 * A Worker stand-in: messages are structured-cloned (transfers honoured) and handled by the
 * real worker code, asynchronously, like a real worker. Only the thread is missing.
 */
class TestWorker implements WorkerLike {
  onmessage: ((ev: MessageEvent<RunResponse>) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  readonly sent: WorkerRequest[] = [];
  terminated = false;
  private readonly handle = createWorkerHandler((res) => {
    setTimeout(() => {
      if (!this.terminated) this.onmessage?.({ data: res } as MessageEvent<RunResponse>);
    });
  });

  postMessage(message: unknown, transfer?: Transferable[] | StructuredSerializeOptions): void {
    if (this.terminated) return;
    const opts = Array.isArray(transfer) ? { transfer } : transfer;
    const req = structuredClone(message, opts) as WorkerRequest;
    this.sent.push(req);
    void this.handle(req);
  }

  terminate(): void {
    this.terminated = true;
  }
}

function setup(decodeInPage?: (f: AudioFile) => Promise<AudioInput>) {
  const workers: TestWorker[] = [];
  const pageDecodes: AudioFile[] = [];
  const runner = new Runner({
    spawn: () => {
      const w = new TestWorker();
      workers.push(w);
      return w;
    },
    decodeInPage: async (f) => {
      pageDecodes.push(f);
      if (!decodeInPage) throw new Error('no page decoder in this test');
      return decodeInPage(f);
    },
  });
  /** Every request sent so far, as [worker index, what it carried]. */
  const log = () =>
    workers.flatMap((w, i) =>
      w.sent.map((r) => ('release' in r ? [i, 'release'] : [i, 'reuse' in r ? 'reuse' : 'input'])),
    );
  return { runner, workers, pageDecodes, log };
}

const ascii = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
const u16 = (n: number) => Uint8Array.from([n & 255, (n >>> 8) & 255]);
const u32 = (n: number) => Uint8Array.from([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, n >>> 24]);

/** Mono 16-bit PCM WAV of `seconds` of a quiet constant signal. */
function wavFile(rate: number, seconds: number, codec = 1): Blob {
  const frames = Math.round(rate * seconds);
  const data = new Uint8Array(frames * 2).fill(0x10);
  const fmt = concatBytes(u16(codec), u16(1), u32(rate), u32(rate * 2), u16(2), u16(16));
  const body = concatBytes(ascii('WAVEfmt '), u32(16), fmt, ascii('data'), u32(data.length), data);
  return new Blob([concatBytes(ascii('RIFF'), u32(body.length), body) as BlobPart]);
}

const kv = (result: Output[], key: string) => {
  const block = result.find((o) => o.type === 'kv');
  return block?.type === 'kv' ? block.entries.find(([k]) => k === key)?.[1] : undefined;
};
const spectrogramOptions = (fftSize = '512') => ({
  fftSize,
  overlap: 50,
  channel: 'mix',
  scale: 'linear',
  colormap: 'gray',
  maxFreq: 0,
  minFreq: 0,
  startTime: 0,
  endTime: 0,
  floor: 90,
  ceiling: 0,
});

describe('runner: audio decoded once and kept in the worker', () => {
  it('sends a file once, then only the options (same input)', async () => {
    const { runner, workers, log } = setup();
    const file = audioFile(wavFile(8000, 1), 'a.wav');
    const first = await runner.run('spectrogram', file, spectrogramOptions('512'));
    expect(kv(first, 'Sample rate')).toBe('8000 Hz (from the file)');
    const second = await runner.run('spectrogram', file, spectrogramOptions('1024'));
    expect(kv(second, 'FFT')).toMatch(/^1024 samples/);
    // The same Blob wrapped again (e.g. the tool page drawn again) is the same input.
    await runner.run('spectrogram', audioFile(file.blob, 'a.wav'), spectrogramOptions());
    expect(log()).toEqual([
      [0, 'input'],
      [0, 'reuse'],
      [0, 'reuse'],
    ]);
    expect(workers).toHaveLength(1);
  });

  it('sends a different file (or the same Blob under another name) again', async () => {
    const { runner, log } = setup();
    const a = audioFile(wavFile(8000, 1), 'a.wav');
    const b = audioFile(wavFile(16000, 1), 'b.wav');
    await runner.run('spectrogram', a, spectrogramOptions());
    const rb = await runner.run('spectrogram', b, spectrogramOptions());
    expect(kv(rb, 'Sample rate')).toBe('16000 Hz (from the file)');
    await runner.run('spectrogram', audioFile(b.blob, 'renamed.wav'), spectrogramOptions());
    const ra = await runner.run('spectrogram', a, spectrogramOptions());
    expect(kv(ra, 'Sample rate')).toBe('8000 Hz (from the file)');
    expect(log().map(([, what]) => what)).toEqual(['input', 'input', 'input', 'input']);
  });

  it('sends it again after a cancelled run killed the worker', async () => {
    const { runner, workers, log } = setup();
    const file = audioFile(wavFile(8000, 2), 'a.wav');
    await runner.run('spectrogram', file, spectrogramOptions());
    const slow = runner.run('spectrogram', file, spectrogramOptions('4096'));
    const next = runner.run('spectrogram', file, spectrogramOptions('2048'));
    await expect(slow).rejects.toBeInstanceOf(CancelledError);
    expect(kv(await next, 'FFT')).toMatch(/^2048 samples/);
    expect(workers.map((w) => w.terminated)).toEqual([true, false]);
    await runner.run('spectrogram', file, spectrogramOptions('256'));
    expect(log()).toEqual([
      [0, 'input'],
      [0, 'reuse'],
      [1, 'input'],
      [1, 'reuse'],
    ]);
  });

  it('frees the kept input when the page releases it', async () => {
    const { runner, log } = setup();
    const file = audioFile(wavFile(8000, 1), 'a.wav');
    await runner.run('spectrogram', file, spectrogramOptions());
    runner.release();
    await runner.run('spectrogram', file, spectrogramOptions());
    expect(log()).toEqual([
      [0, 'input'],
      [0, 'release'],
      [0, 'input'],
    ]);
  });

  it('keeps nothing when the file fails to decode, and says why', async () => {
    const { runner, log } = setup();
    const broken = audioFile(new Blob([ascii('RIFF\0\0\0\0WAVEjunk')]), 'x.wav');
    for (let i = 0; i < 2; i++) {
      await expect(runner.run('spectrogram', broken, spectrogramOptions())).rejects.toThrow(
        'WAV file has no "data" chunk.',
      );
    }
    expect(log().map(([, what]) => what)).toEqual(['input', 'input']);
  });

  it('keeps the audio across runs of other tools, which are sent every time as before', async () => {
    const { runner, log } = setup();
    const file = audioFile(wavFile(8000, 1), 'a.wav');
    await runner.run('spectrogram', file, spectrogramOptions());
    for (let i = 0; i < 2; i++) {
      const out = await runner.run('caesar', 'iodj{fdhvdu}', {
        mode: 'shift',
        alphabet: 'letters',
        shift: -3,
      });
      expect(out).toEqual([{ type: 'text', value: 'flag{caesar}' }]);
    }
    await runner.run('spectrogram', file, spectrogramOptions());
    expect(log().map(([, what]) => what)).toEqual(['input', 'input', 'input', 'reuse']);
  });
});

describe('runner: codecs only the browser decodes', () => {
  /** What decodeAudioData would give: here, a 440 Hz tone at the file's rate. */
  const browserDecode = async (f: AudioFile): Promise<AudioInput> => {
    const bytes = new Uint8Array(await f.blob.arrayBuffer());
    const channels = [Float32Array.from({ length: 22050 }, (_, i) => Math.sin(i * 0.1254))];
    return { bytes, name: f.name, sampleRate: 22050, channels, rateSource: 'file' } as AudioInput;
  };

  it('asks the page once, keeps the samples it sends, and goes to the page directly next time', async () => {
    const { runner, pageDecodes, log } = setup(browserDecode);
    const mp3ish = audioFile(new Blob([Uint8Array.of(0xff, 0xfb, 0x90, 0x64, 0, 0, 0)]), 'a.mp3');
    const first = await runner.run('spectrogram', mp3ish, spectrogramOptions());
    expect(kv(first, 'Sample rate')).toBe('22050 Hz (from the file)');
    await runner.run('spectrogram', mp3ish, spectrogramOptions('1024'));
    expect(pageDecodes).toHaveLength(1);
    // Cancel: the worker and its samples are gone; the page decodes again, without asking.
    const slow = runner.run('spectrogram', mp3ish, spectrogramOptions('4096'));
    const next = runner.run('spectrogram', mp3ish, spectrogramOptions('256'));
    await expect(slow).rejects.toBeInstanceOf(CancelledError);
    expect(kv(await next, 'FFT')).toMatch(/^256 samples/);
    expect(pageDecodes).toHaveLength(2);
    expect(log()).toEqual([
      [0, 'input'], // the Blob: the worker answers "decode it in the page"
      [0, 'input'], // the decoded samples, transferred
      [0, 'reuse'],
      [0, 'reuse'], // cancelled
      [1, 'input'], // decoded by the page again, sent straight away
    ]);
  });

  it('transfers the samples: the page keeps no copy', async () => {
    let sent: AudioInput | null = null;
    const { runner } = setup(async (f) => (sent = await browserDecode(f)));
    await runner.run('spectrogram', audioFile(new Blob([ascii('OggS....')])), spectrogramOptions());
    expect(sent!.channels[0]!.length).toBe(0); // detached by the transfer
    expect(sent!.bytes.length).toBe(0);
  });

  it('reports the page decoder error (e.g. the WAV codec it lacks)', async () => {
    const { runner } = setup();
    const ima = audioFile(wavFile(8000, 1, 0x11), 'ima.wav');
    await expect(runner.run('spectrogram', ima, spectrogramOptions())).rejects.toThrow(
      'no page decoder in this test',
    );
  });
});

describe('runner without workers', () => {
  it('decodes an audio file inline', async () => {
    const runner = new Runner({ spawn: () => null });
    const out = await runner.run('spectrogram', audioFile(wavFile(8000, 1)), spectrogramOptions());
    expect(kv(out, 'Sample rate')).toBe('8000 Hz (from the file)');
  });
});

describe('audio tools leave their input untouched (the worker reuses it for the next run)', () => {
  const loadSample = async (name: string) =>
    new Uint8Array(await readFile(new URL(`../../public/samples/${name}`, import.meta.url)));
  const audioTools = TOOLS.filter((tool) => tool.input === 'audio');

  it.each(audioTools.map((tool) => [tool.id, tool] as const))('%s', async (_id, tool) => {
    expect(tool.examples.length).toBeGreaterThan(0);
    for (const ex of tool.examples) {
      const input = (await prepareInput(
        'audio',
        await exampleToRaw(ex.input, loadSample),
      )) as AudioInput;
      const before = input.channels.map((c) => c.slice());
      const options = {
        ...defaultOptions(tool),
        ...(await resolveExampleOptions(tool, ex.options, loadSample)),
      };
      await tool.run(input as never, options as never);
      expect(input.channels).toEqual(before);
    }
  });
});
