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

Pick `bytes` whenever the data might be binary (decoders, XOR, forensics). Pick `text` for
classical ciphers and anything that is really about characters.

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
| `{ type: 'note', level, text }`                     | info / warn / error / success line                        |

Return bytes rather than a lossy string when the result can be binary.

## 5. Errors

Throw `new ToolError('Human sentence saying what is wrong and how to fix it.')`
(`core/errors`). Anything else is shown as an "Unexpected error" — that is a bug.

## 6. Examples are tests

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

Sample files live in `public/samples/`. Keep them tiny, generated by a script in `scripts/`
when possible, and never use copyrighted material.

Add a `<id>.test.ts` next to the tool for edge cases (round-trips, malformed input).
Test real behaviour with real data — no mocks of the code under test.

## 7. Triage (optional, recommended)

`detect(sample)` lets the home page suggest your tool for pasted data or dropped files.
It must be cheap and side-effect free. Return `null` when unsure.

```ts
detect({ text, bytes, name }) {
  if (!text || !/^[01\s]+$/.test(text)) return null;
  return { score: 0.85, options: { mode: 'decode' }, reason: 'Only 0 and 1' };
}
```

`text` is `null` for binary files. Scores: 0.9 = "certainly", 0.5 = "plausible", < 0.25 is ignored.

## 8. Shared code

- `src/lib/bytes.ts` — UTF-8/latin1, hex, base64, printable ratio, byte search, LE/BE reads.
- `src/lib/english.ts` — `plaintextScore`, `chiSquared`, `indexOfCoincidence` for brute-forcers.
- `src/lib/signatures.ts` — magic-byte database (file type + carving).

Helpers used by one tool only can live next to it as `_name.ts` (files starting with `_`
are not registered as tools).

## 9. Rules

- **Client-side only.** No network requests, no server, no telemetry. Libraries are bundled.
- **Analysis of user-provided data only.** No scanners, no requests to third-party targets,
  no online brute-force. This is what keeps the site legal to host publicly.
- Never use `innerHTML`; tools never touch the DOM anyway.
- Pure and deterministic: same input + options → same output.
- `npm run check` must pass (types, lint, format, tests), then `npm run test:e2e`.
