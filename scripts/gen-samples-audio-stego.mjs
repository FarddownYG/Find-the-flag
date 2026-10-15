// Deterministic sample files for the "Audio steganography" tool.
// Run: node scripts/gen-samples-audio-stego.mjs   (run it again: the bytes are identical)
//
//   audio-stego-lsb.wav    16-bit mono WAV: "FTF{wav_lsb}" in the low bit of the samples, behind a
//                          32-bit big-endian length, starting in a stretch of digital silence
//   audio-stego-png.wav    24-bit stereo WAV: a PNG (the flag, drawn) in the 2 low bits of the left
//                          channel only
//   audio-stego-chunk.wav  16-bit mono WAV with an extra "ftfx" chunk holding a flag and a ZIP
//                          (holding another) glued after the last chunk
//   audio-stego-id3.mp3    MP3 made of silent frames: ID3v2.3 tag with a comment holding a flag and
//                          a cover picture, a Xing header, an ID3v1 tag
//
// The files are made by the same builders the tool's tests use (loaded through Vite), so the
// samples and the tests cannot drift apart. Made-up messages, no real challenge file.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'vite';

const vite = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
});
const { buildSamples } = await vite.ssrLoadModule('/src/tools/audio/_audio-stego-samples.ts');
await vite.close();

const OUT = new URL('../public/samples/', import.meta.url);
mkdirSync(OUT, { recursive: true });
for (const [name, bytes] of Object.entries(buildSamples())) {
  if (bytes.length >= 100 * 1024) throw new Error(`${name} is ${bytes.length} bytes`);
  writeFileSync(new URL(name, OUT), bytes);
  console.log(`${name}: ${bytes.length} bytes`);
}
