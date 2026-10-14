import { describe, expect, it } from 'vitest';
import { resultToText } from './result-text';

describe('resultToText', () => {
  it('describes an audio block by type, name and size, whatever holds the bytes', () => {
    const wav = new Uint8Array(1044);
    expect(
      resultToText([{ type: 'audio', label: 'Result', data: wav, filename: 'voice-lab.wav' }]),
    ).toBe('Result\n[audio audio/wav voice-lab.wav, 1044 bytes]');
    const blob = new Blob([new Uint8Array(10)], { type: 'audio/ogg' });
    expect(resultToText([{ type: 'audio', data: blob, mime: 'audio/ogg' }])).toBe(
      '[audio audio/ogg, 10 bytes]',
    );
  });
});
