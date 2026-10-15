# Adding a tool

A tool is **one TypeScript file** in `src/tools/<category>/`. It default-exports a
`defineTool({...})` object. There is no registry to edit, no UI to write: the file is
discovered automatically, gets a page at `#/tool/<id>`, a sidebar entry, search, options
widgets, example buttons, "Send to…" piping, flag highlighting and two test suites.

## 1. Minimal tool

```ts
// src/tools/encoding/reverse.ts
import { defineTool, toggle } from '../../core/define';

export default defineTool({
  id: 'reverse', // kebab-case, unique, it is the URL
  name: 'Reverse',
  category: 'misc', // encoding | crypto | stego | forensics | audio | misc
  description: 'Reverse a string, or every line separately.', // one line, plain words
  tags: ['backwards', 'mirror'], // aliases people may search for
  input: 'text',
  options: {
    scope: toggle('Reverse', [
      { value: 'all', label: 'Whole text' },
      { value: 'lines', label: 'Each line' },
    ]),
  },
  examples: [{ label: 'Reversed flag', input: '}desrever{galf', expect: 'flag{reversed}' }],
  run(text, { scope }) {
    const rev = (s: string) => [...s].reverse().join('');
    const value = scope === 'all' ? rev(text) : text.split('\n').map(rev).join('\n');
    return [{ type: 'text', value }];
  },
});
```

That is all. `npm run dev`, open `#/tool/reverse`.

## 2. Inputs

| `input` | `run` receives                                                       | UI                                                    |
| ------- | -------------------------------------------------------------------- | ----------------------------------------------------- |
| `text`  | `string`                                                             | textarea (+ open file as text)                        |
| `bytes` | `{ bytes: Uint8Array; name?: string }`                               | textarea read as UTF-8 / hex / base64, or a file      |
| `image` | `{ bytes, name, image: { width, height, data: Uint8ClampedArray } }` | drop zone; RGBA pixels, **exact** for PNG/BMP         |
| `audio` | `{ bytes, name, sampleRate, channels: Float32Array[] }`              | drop zone; WAV decoded exactly, others by the browser |
| `file`  | `LazyFile { name, size, blob, read(offset, length) }`                | drop zone; **nothing is read up front**               |

Pick `bytes` whenever the data might be binary (decoders, XOR, forensics). Pick `text` for
classical ciphers and anything that is really about characters. Pick `file` when inputs can be
big (disk images, captures, dumps): only the Blob handle reaches the worker and the tool reads
the slices it needs (`await input.read(offset, 65536)`), so a multi-gigabyte file never sits in
memory. Scan in chunks with a small overlap, and cap what you render.

`audio` inputs are decoded off the page's thread: WAV (PCM, float, A-law, µ-law) in the tool
worker, everything else (MP3, OGG, FLAC, AAC, ADPCM WAV...) by the browser's decoder, which also
runs off the main thread. The decoded samples are kept in the worker and reused by every run of
the same file, so changing an option sends only the options. Never modify `channels` in place:
the next run gets the same arrays.

## 3. Options

Import the builders from `core/define`. Values arrive typed in `run`.

```ts
options: {
  mode: toggle('Mode', ['decode', 'encode']),            // segmented buttons, first = default
  alphabet: select('Alphabet', ['std', 'url'], 'std'),    // dropdown
  key: text('Key', '', { placeholder: 'secret' }),
  shift: number('Shift', 3, { min: 0, max: 25 }),
  strict: bool('Strict', false, { hint: 'Fail on invalid characters' }),
  // Show a control only when it matters:
  pad: bool('Pad', true, { showIf: (v) => v.mode === 'encode' }),
  // A second file (value: null until chosen; 'image' gives decoded pixels like the main input):
  other: file('Second image', 'image'),
}
```

Choices can be plain strings or `{ value, label }` when the label should be friendlier.
In examples, a file option takes a sample name: `options: { other: { sample: 'b.png' } }`.

### Symbol keyboard

A text tool whose input is a picture alphabet (Pigpen, semaphore, Braille...) can add
`keypad: (options) => KeypadKey[]`: an on-screen keyboard under the text box, one key per drawn
symbol. A key is `{ text, label, glyph }`: pressing it types `text` at the caret of the text box
(Space, Backspace and Clear come with the keyboard), `label` is the name a screen reader says (the
letter), `glyph` is the symbol as SVG paths in a box (`{ w, h, shapes: [{ d, fill?, stroke?, width?,
opacity? }] }`, `'ink'` is the text colour). The keys are asked again whenever an option changes.
The page draws them with the DOM API, never from a markup string. See `symbol-ciphers`.

## 4. Outputs

`run` returns an array of blocks (sync or async). Mix as many as useful:

| Block                                               | Rendered as                                               |
| --------------------------------------------------- | --------------------------------------------------------- |
| `{ type: 'text', value, label? }`                   | copyable text, flags highlighted, pipeable                |
| `{ type: 'bytes', value: Uint8Array, filename? }`   | text/hex toggle, download, pipeable                       |
| `{ type: 'table', columns, rows, highlight? }`      | table with TSV copy; `highlight: [0]` marks the best rows |
| `{ type: 'kv', entries: [[k, v], ...] }`            | definition list                                           |
| `{ type: 'image', image: RgbaImage, filename? }`    | canvas, click to zoom 1:1, PNG download                   |
| `{ type: 'files', files: [{ name, data, note? }] }` | list with download + "Send to…" per file                  |
| `{ type: 'picture', data, mime, filename? }`        | an image shown as-is (JPEG...; SVG: + PNG, Print)         |
| `{ type: 'audio', data, mime?, filename? }`         | audio player + download + "Send to" an audio tool         |
| `{ type: 'map', lat, lon, zoom? }`                  | coordinates + map links; opt-in OpenStreetMap map         |
| `{ type: 'note', level, text }`                     | info / warn / error / success line                        |

Return bytes rather than a lossy string when the result can be binary. For a large extracted
file, put a `Blob` in `files[].blob` (with an empty `data`): it is downloaded without copying.
For sound, put the encoded file (e.g. a 16-bit WAV) in `audio.data`: the worker hands a
`Uint8Array` to the page as a Blob (so don't reuse the array after returning it), the player
plays it from a `blob:` URL that is revoked when the output is drawn again.

## 5. Translations (required)

The UI ships in English, French, Russian, Simplified Chinese and Hindi. **Every text a user can
see goes through a key**, or the translation coverage degrades with each new tool.

- Declarative text (name, description, placeholder, option labels / hints / choices, example
  labels) stays in English in the tool file; it gets derived keys automatically
  (`tool.<id>.name`, `tool.<id>.options.<key>.label`, …). Run `npm run i18n:extract` to copy
  it into `src/i18n/locales/en.json`.
- Runtime text (output labels, table columns, kv keys, notes, `ToolError` messages, detect
  reasons) uses keys: `const T = toolT('my-tool');` then `T('note.binary', { size })`, with
  the English in `en.json` under `tool.my-tool.note.binary`. Don't use the reserved sub-keys
  `name`, `description`, `placeholder`, `options`, `examples`. Placeholders are `{name}`; for
  counts pass `{ count }` and add `_one` / `_other` forms (`_few` / `_many` too in Russian).
- Add the same keys to `fr.json`, `ru.json`, `zh.json` and `hi.json` (merge a fragment with
  `node scripts/i18n.mjs add frag.json`). Keep technical terms and proper names untouched in
  every language (base64, XOR, EXIF, Whitespace, hash, flag, GPS… — the list is
  `src/i18n/glossary.json`); descriptive tool names ("File type") are translated. When the
  English uses a glossary term as a plain word ("flag unusual spaces"), list the key under
  `exempt` in the glossary instead of forcing the term into the translation.
- In a sentence with two numbers, the plural form follows `{count}`: in Russian, phrase it as
  "noun: {x} из {count}" when a verb would have to agree with the other number.
- `npm run i18n:check` fails on a key missing in one locale, a stale key, a missing plural
  form, a placeholder mismatch or a translated technical term. While working on one tool:
  `node scripts/i18n.mjs check --prefix=tool.my-tool.`
- Example `expect` strings are checked against the English output.

## 6. Errors

Throw `new ToolError('Human sentence saying what is wrong and how to fix it.')`
(`core/errors`). Anything else is shown as an "Unexpected error" — that is a bug.

## 7. Examples are tests

Every tool needs at least one example. Each one:

- becomes a **Try** button in the UI (that is how people learn the tool without docs);
- is executed by `npm test` (Node) **and** `npm run test:e2e` (real Chromium, through the UI):
  the rendered output must contain `expect`.

```ts
examples: [
  { label: 'Decode', input: 'ZmxhZ3t9', expect: 'flag{}' },
  { label: 'With options', input: 'abc', options: { mode: 'encode' }, expect: '...' },
  { label: 'Binary input', input: { hex: '89504e47' }, expect: 'PNG' },
  { label: 'Sample file', input: { sample: 'lsb-flag.png' }, expect: 'flag{' }, // public/samples/
];
```

Keep `expect` within one rendered value (a text block, one table cell, or one `kv` pair
written `Key: value`): the browser suite matches the page text, where table cells are not
separated.

In the UI the result of a Try example carries a **Demo** banner (with the example label and the
sample name) and its flag candidates are marked as coming from the demo sample, so a demo can
never be mistaken for the analysis of the user's own input. The banner goes away as soon as the
user's own input replaces the example, and opening a file puts the options the example set back to
their defaults (options the user changed by hand are kept). So give an example a label that says
what it demonstrates, and never rely on example-only options for a tool to work on real files.

Sample files live in `public/samples/`. Keep them tiny, generated by a script in `scripts/`
when possible, and never use copyrighted material.

Add a `<id>.test.ts` next to the tool for edge cases (round-trips, malformed input).
Test real behaviour with real data — no mocks of the code under test.

## 8. Triage (optional, recommended)

`detect(sample)` lets the home page suggest your tool for pasted data or dropped files.
It must be cheap and side-effect free. Return `null` when unsure.

```ts
detect({ text, bytes, name }) {
  if (!text || !/^[01\s]+$/.test(text)) return null;
  return { score: 0.85, options: { mode: 'decode' }, reason: 'Only 0 and 1' };
}
```

`text` is `null` for binary files. Scores: 0.9 = "certainly", 0.5 = "plausible", < 0.25 is ignored.

## 9. Shared code

- `src/lib/bytes.ts` — UTF-8/latin1, hex, base64, printable ratio, byte search, LE/BE reads.
- `src/lib/english.ts` — `plaintextScore`, `chiSquared`, `indexOfCoincidence` for brute-forcers.
- `src/lib/readability.ts` — `readability` (0..100: does this read as French or English? It
  also reports how well neighbouring words fit and the set phrases found), `segmentWords`
  (split `CETTENUIT` into words), `wordSplit` (the same, with how unlikely such a split is by
  chance, in bits), `orderFit` (how naturally lines follow on from one another),
  `foldAccents`, `wordRank`, `isFunctionWord`, `letterFrequencies`. Word lists are in
  `src/lib/wordlists/`. Use it to rank candidates that may be French, or whose words were
  picked from a text.
- `src/lib/signatures.ts` — magic-byte database (file type + carving).

Helpers used by one tool only can live next to it as `_name.ts` (files starting with `_`
are not registered as tools).

## 10. Rules

- **Client-side only.** No network requests, no server, no telemetry. Libraries are bundled.
- **Analysis of user-provided data only.** No scanners, no requests to third-party targets,
  no online brute-force. This is what keeps the site legal to host publicly.
- Never use `innerHTML`; tools never touch the DOM anyway.
- Pure and deterministic: same input + options → same output.
- `npm run check` must pass (types, lint, format, tests, i18n, privacy), then `npm run test:e2e`.
