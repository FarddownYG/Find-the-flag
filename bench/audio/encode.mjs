// Reference encoder (independent): LSB audio stego in 16-bit mono PCM WAV.
// Payload = UTF-8 flag bytes, MSB first, one bit per sample LSB, no length header.
// Remaining sample LSBs are fixed to 0 (no random noise).
export function encodeLsbWav(numSamples, flag, sampleRate = 8000) {
  const payload = Buffer.from(flag, 'utf8');
  if (payload.length * 8 > numSamples) throw new Error('carrier too small');
  const dataLen = numSamples * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < numSamples; i++) {
    // low-amplitude tone (|s| <= ~300), then force the LSB
    let s = Math.round(300 * Math.sin((2 * Math.PI * 220 * i) / sampleRate));
    s &= ~1;
    if (i < payload.length * 8) s |= (payload[i >> 3] >> (7 - (i & 7))) & 1;
    buf.writeInt16LE(s, 44 + i * 2);
  }
  return buf;
}
