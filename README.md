# Find The Flag

An open-source toolbox for solving CTF challenges, entirely in your browser.

Paste a string or drop a file on the home page and it suggests which tools fit. Each tool
page has **Try** buttons with real examples, so nothing needs a manual. An example is always
labelled **Demo** in the output, and the label goes away the moment you open, drop or paste
your own input (a file you open also puts the example's options back to their defaults). Outputs can be sent to another tool in
one click to chain steps, and anything that looks like a flag (`flag{…}`, `CTF{…}`, or your
event's own format) gets highlighted.

The full list is in [docs/TOOLS.md](docs/TOOLS.md). It covers:

- **Encoding**: Base16/32/58/62/64/85/91, binary, char codes, URL, HTML entities, Unicode escapes, Morse, phone keypad (multi-tap with or without separators, T9, encoding, vanity numbers like 1-800-FLOWERS), and a CyberChef-style auto-decoder.
- **Crypto**: ROT/Caesar, XOR (brute force, repeating-key crack, known plaintext), Vigenère (with cracking), Atbash, affine, Bacon, rail fence, columnar transposition (double, Myszkowski, route / spiral, scytale, and a solver that finds the key from the ciphertext), Polybius / tap code, ADFGX / ADFGVX (keyed 5×5 or 6×6 square, your own coordinate letters, columnar transposition key), Nihilist cipher (Polybius numbers plus a repeating key, with a key-length helper that reads the number stream, and the Nihilist transposition), substitution solver, frequency analysis, Enigma machine (Enigma I, M3 and M4 with real rotors, rings and plugboard, a step table that follows every key press and the double step, crib positions and a crib search for the rotor order and start positions), hash identification and computation, JWT, symmetric ciphers (AES in ECB / CBC / CTR / CFB / OFB / GCM, DES / 3DES, RC4, ChaCha20 and ChaCha20-Poly1305; reads `openssl enc` files with their `Salted__` header, EVP_BytesToKey or `-pbkdf2` key derivation, checks the padding or tag to tell a right key from a wrong one, and can try every mode on your key).
- **Steganography**: LSB extraction (zsteg-style auto scan), EMD (Exploiting Modification Direction: groups of n pixels carry one base-(2n+1) digit; decodes with your n, k, weights, digit order, scan, offset and channel and shows the text, the printable and readable rates and the raw digit stream, searches the usual settings ranked by readability with a one-click "use these settings", or hides a message in a cover image with a round-trip check; lossless PNG only), hidden bits in base64 / base32 padding (the unused bits of the last symbol of each padded line, read MSB first into bytes with the count of lines per padding type and the ordinary decoding next to them; follows up to 8 layers by itself when the hidden payload is again base64 / base32 lines, or hides a message that way with a round-trip check), bit planes and colour filters (stegsolve-style), PNG/JPEG/GIF structure (with IHDR CRC repair), a PNG chunk surgeon for black or broken PNGs (lists every chunk where pngcheck stops at the first error, shows the text chunks, puts shuffled IDAT chunks back in order from a text-chunk hint, by hand or by search, repairs CRCs, signature, zlib header and IHDR size, and shows the rebuilt image), EXIF/metadata, an aperisolve-style image analyzer (every EXIF/IPTC/XMP/ICC field, GPS on a map, MD5/SHA hashes and file comparison, EXIF thumbnail checked against the picture, appended data, strings), QR codes, printer tracking dots (the Xerox DocuColor "yellow dots" found in a scan and decoded to print date, time and printer serial with a parity check, or a pasted / built 15 × 8 dot matrix), a colour-channel reveal (R/G/B/C/M/Y/K, colour ink only, contrast stretch), zero-width Unicode text, hidden Unicode text (lookalike letters found from the Unicode 16.0.0 confusables data, with every unusual code point named and shown with its category and block; invisible characters read in every scheme: zero-width binary with any pair of ZWSP / ZWNJ / ZWJ / BOM / word joiner, tag characters, variation selectors; the pattern of swapped letters read as a hidden channel; and an encoder for each, with a round-trip check), whitespace, and a full-scan text analyzer that runs every hidden-text check on a pasted text at once (acrostics of lines, words, sentences and paragraphs, regular picks, line orders and columns, invisible characters, trailing whitespace, homoglyphs and letter case as bits, encodings including leet, Morse and phone multi-tap, text typed with the wrong keyboard layout, classical ciphers with French and English key recovery) and ranks the results by French / English readability and by how unlikely each find is by chance.
- **Forensics**: hexdump / `xxd -r`, file type from magic bytes, `strings`, carving of embedded files (binwalk-style), archive extraction (including ZipCrypto with a known password), entropy, and a binary analyzer for big unknown files and disk images (a BIN without its CUE: sector layout, data and audio tracks, rebuilt `.cue`, cooked `.iso`, ISO 9660 / Joliet / Rock Ridge files; FAT12/16/32 with deleted files; raw data as numbers, ENVI rasters), read in chunks so multi-gigabyte images never sit in memory (copies out of raw CD sectors stay under 64 MiB unless asked).
- **Audio**: spectrogram (the file's real sample rate is read from the MP3 / FLAC / Ogg / Opus / AAC / MP4 header before decoding, so nothing is resampled; the default view is the whole 0 Hz to Nyquist band, with FFT size, frequency and time zoom, log or linear axis, colour maps and labelled axes), DTMF tones, Morse from audio, and an audio lab that makes a voice listenable again: reverse, speed up / slow down with the pitch (band-limited resampling), time-stretch and pitch-shift separately (WSOLA), left / right / mid / side channels with an exact mono check, chained in any order ("reverse, speed 1/1.5" undoes a reversed voice sped up ×1.5), with a player, a WAV download and the spectrogram of the result. It does no speech recognition: you do the listening.
- **Misc**: number bases and `long_to_bytes`, timestamps, text transforms.

## Principles

- **Everything runs client-side.** No backend, no account, no database. Files you open never
  leave the tab. Fonts and libraries are bundled; the page makes no third-party requests and
  ships a strict Content-Security-Policy. The one opt-in exception: when a photo has a GPS
  position, clicking **Show map** loads OpenStreetMap tiles of that area (coordinates and
  map links are shown without it).
- **No telemetry, no tracking, no cookies.** The only thing stored is your optional custom
  flag pattern, in your own browser's `localStorage`.
- **Analysis only.** The tools decode, decrypt, identify and extract data that _you_ provide.
  There are no scanners, exploit tools, or anything that sends traffic to a third-party
  system. Keep contributions within that scope: it is what makes the site legal to host
  publicly.

## Languages

The interface is available in English, French, Russian, Simplified Chinese and Hindi. The
language follows your browser, and the picker at the top of the sidebar overrides it (the
choice is kept in `localStorage`). Translations are static files in `src/i18n/locales/`;
nothing is translated at run time. Technical terms and tool names (base64, XOR, EXIF,
Whitespace, hash, flag, GPS…) stay as they are in every language.

| Language       | Status                                                       |
| -------------- | ------------------------------------------------------------ |
| English (`en`) | source                                                       |
| French (`fr`)  | complete                                                     |
| Russian (`ru`) | complete, **native review to do** (relecture native à faire) |
| Chinese (`zh`) | complete, **native review to do** (relecture native à faire) |
| Hindi (`hi`)   | complete, **native review to do** (relecture native à faire) |

The Russian, Chinese and Hindi files were written without a native speaker; corrections
are welcome, and [docs/TRANSLATION_REVIEW.md](docs/TRANSLATION_REVIEW.md) lists what to check
first. `npm run i18n:check` fails on a key missing from one language, a stale key, a
missing plural form, a placeholder mismatch or a translated technical term.

## Run it

```sh
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/ — host it anywhere (relative paths)
```

The build is plain static files: GitHub Pages, any web server, or `npx vite preview`.
The live site is deployed by Vercel from `main`; the CI workflow (`.github/workflows/ci.yml`)
runs every check on each push and pull request.

## Add a tool

One file in `src/tools/<category>/`, nothing else to register. See
[docs/ADDING_A_TOOL.md](docs/ADDING_A_TOOL.md). A minimal tool is about 20 lines.

## Checks

```sh
npm run check      # types, lint, format, unit tests (every tool example runs), i18n, privacy
npm run test:e2e   # every tool example, clicked through the real UI in Chromium
npm run docs:tools # regenerate docs/TOOLS.md after adding a tool
```

`npm run test:e2e` uses Playwright's Chromium (`npx playwright install chromium`), or set
`CHROMIUM_PATH` to an existing Chromium binary.

`npm run check:privacy` fails on personal data in tracked files or in commit metadata
(e-mail addresses, home paths, keys, tokens). Commit with a no-reply address, for example
`git config user.email "<id>+<username>@users.noreply.github.com"`.

## Architecture

```
src/core/      tool contract (types.ts), registry (auto-discovery), worker runner,
               exact PNG/BMP/WAV decoders, flag spotting
src/lib/       shared helpers: bytes/hex/base64, English scoring, French + English
               readability (word lists, word classes, set phrases), magic-byte database
src/tools/     one file per tool, grouped by category
src/ui/        the shell: sidebar, triage, tool page, output renderers, styles
e2e/           Playwright suite generated from the tool examples
scripts/       sample generators and maintenance scripts
public/samples small generated files used by the examples
```

Tools are pure functions `(input, options) → output blocks`. The shell builds the form from
the tool's declaration, runs it in a Web Worker (typing cancels the previous run), and
renders the blocks. Big inputs never block the page: audio is decoded in the worker and kept
there between runs, files read on demand reach it as a handle only. Tools never touch the DOM, so they also run in Node for the tests.

## Licence

Copyright (C) 2026 Find The Flag contributors. [GNU GPL v3](LICENSE) or later (`GPL-3.0-or-later`): you may use, study, change and share
the code; versions you distribute must stay under the same licence, with their source.
Third-party packages keep their own licences: `fflate`, `fast-png`, `exifr`,
`hash-wasm` (MIT), `jsqr` (Apache-2.0), `jpeg-js` (BSD-3-Clause), Leaflet (BSD-2-Clause),
Martian Mono, Noto Sans SC and Noto Sans Devanagari (SIL Open Font License 1.1). Map tiles © OpenStreetMap contributors.
The Unicode 16.0.0 data of the hidden-Unicode tool (names, categories, blocks, confusables) is under the Unicode License v3: see [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
