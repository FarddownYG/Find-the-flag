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
| `{ type: 'picture', data, mime, filename? }`        | an encoded image shown as-is (e.g. a JPEG thumbnail)      |
| `{ type: 'map', lat, lon, zoom? }`                  | coordinates + map links; opt-in OpenStreetMap map         |
| `{ type: 'note', level, text }`                     | info / warn / error / success line                        |

Return bytes rather than a lossy string when the result can be binary. For a large extracted
file, put a `Blob` in `files[].blob` (with an empty `data`): it is downloaded without copying.

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
- Add the same keys to `fr.json`, `ru.json`, `zh.json` and `hi.json`. Keep technical terms and
  tool names untouched in every language (base64, XOR, EXIF, Whitespace, hash, flag, GPS… —
  the list is `src/i18n/glossary.json`).
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
