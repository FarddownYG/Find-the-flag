/**
 * The detection-rate corpus: samples under public/samples/ and what analyze() must find in each.
 * Read by scripts/detect-bench.mjs. Entries with `clean: true` hide nothing (false-positive check).
 * All files are made-up fixtures built by the scripts in scripts/.
 */
export type CorpusExpect = { flag: string } | { kind: string };

export interface CorpusEntry {
  /** File name under public/samples/. */
  file: string;
  technique: string;
  expect?: CorpusExpect;
  clean?: boolean;
}

export const CORPUS: CorpusEntry[] = [
  // existing samples
  {
    file: 'stego-lsb.png',
    technique: 'LSB in pixels',
    expect: { flag: 'flag{lsb_hidden_in_pixels}' },
  },
  {
    file: 'stego-pvd.png',
    technique: 'PVD (pixel-value differencing)',
    expect: { flag: 'FTF{pvd_serpentine}' },
  },
  {
    file: 'stego-pit.png',
    technique: 'PIT (pixel indicator)',
    expect: { flag: 'FTF{pit_indicator}' },
  },
  {
    file: 'stego-lsb-zone.png',
    technique: 'LSB on a zone (row 0, step 2)',
    expect: { flag: 'FTF{lsb_row0_step2}' },
  },
  {
    file: 'angecryption-sample.bin',
    technique: 'AngeCryption (encrypted polyglot)',
    expect: { kind: 'encrypted' },
  },
  {
    file: 'extract-nested.zip',
    technique: 'nested zip > png > text chunk > base64',
    expect: { flag: 'FTF{extract_unwraps_layers}' },
  },
  {
    file: 'forensics-polyglot.png',
    technique: 'polyglot PNG + ZIP',
    expect: { flag: 'flag{binwalk_found_me}' },
  },
  { file: 'audio-stego-lsb.wav', technique: 'WAV LSB', expect: { flag: 'FTF{wav_lsb}' } },
  {
    file: 'stego-trailing.png',
    technique: 'ZIP after PNG IEND',
    expect: { flag: 'flag{appended_after_iend}' },
  },
  // new fixtures
  {
    file: 'mp4-encrypted-mdat.mp4',
    technique: 'MP4 unreferenced high-entropy mdat (encrypted container)',
    expect: { kind: 'encrypted' },
  },
  {
    file: 'zip-in-jpeg.jpg',
    technique: 'ZIP after JPEG EOI',
    expect: { flag: 'FTF{zip_after_jpeg}' },
  },
  {
    file: 'pdf-attachment-b64.pdf',
    technique: 'PDF embedded file, base64 PNG with tEXt flag',
    expect: { flag: 'FTF{pdf_attached_b64}' },
  },
  {
    file: 'x86-stego.bin',
    technique: 'x86 instruction-encoding stego',
    expect: { flag: 'FTF{x86_encoded}' },
  },
  {
    file: 'symbol-words.txt',
    technique: 'words as symbols (nibble-per-word)',
    expect: { flag: 'FTF{symbol_words}' },
  },
  {
    file: 'apng-hidden.png',
    technique: 'APNG frames with split zTXt chunks',
    expect: { flag: 'FTF{apng_frames}' },
  },
  // clean controls
  { file: 'clean-photo.jpg', technique: 'clean JPEG', clean: true },
  { file: 'clean-doc.pdf', technique: 'clean PDF', clean: true },
  { file: 'clean-video.mp4', technique: 'clean MP4', clean: true },
];
