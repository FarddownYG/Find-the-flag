// Deterministic sample files for the Whitespace (esolang) tool.
// Run: node scripts/gen-samples-whitespace.mjs
//
// One home-made program prints exactly "FTF\n". It stores the string in the heap, then walks it
// with a loop (conditional jump on the 0 that ends the string) and prints each character from a
// subroutine. The same program is written four ways: bare, hidden in the trailing whitespace of
// an original poem, interleaved with letters, and between BEGIN/END markers in prose.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'vite';

// The tool's own assembler and cover-text hider (TypeScript, loaded through Vite).
const vite = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
});
const { assemble, hideInCover } = await vite.ssrLoadModule('/src/tools/misc/_ws-asm.ts');
const { toWhitespace } = await vite.ssrLoadModule('/src/tools/misc/_ws-core.ts');
await vite.close();

const OUT = new URL('../public/samples/', import.meta.url);
mkdirSync(OUT, { recursive: true });
const write = (name, text) => {
  writeFileSync(new URL(name, OUT), text);
  console.log(`${name}: ${Buffer.byteLength(text)} bytes`);
};

// LOOP = ST, PRINT = TS, DONE = TT.
const FTF = `
  push 0
  push 70     ; 'F'
  store       ; heap[0] = 'F'
  push 1
  push 84     ; 'T'
  store
  push 2
  push 70     ; 'F'
  store
  push 3
  push 10     ; '\\n'
  store       ; heap[4] is never stored: it reads as 0 and ends the string
  push 0      ; i
label ST      ; LOOP
  dup
  retrieve    ; i c
  dup
  jz TT       ; i c   (c == 0: go to DONE)
  call TS     ; i     (PRINT pops c)
  push 1
  add         ; i + 1
  jump ST
label TS      ; PRINT
  outchar
  ret
label TT      ; DONE
  end
`;

const code = assemble(FTF);
const program = toWhitespace(code);

// ---------- 1. bare program ----------

write('esolang-ftf.ws', program);

// ---------- 2. hidden in the trailing whitespace of a poem ----------
// The program is cut at each L: piece k goes at the end of line k and the line break is the L.

const POEM = `The Quiet Keeper

A lighthouse stands where the rocks run thin,
its lamp gone dark for a year or two;
the keeper still climbs at the close of day
and polishes glass that no ship looks through.

He keeps a log that nobody reads,
in ink the colour of rain on slate,
and every line that he leaves behind
runs on a little past where it should wait.

The gulls have guessed it, the tide has too:
a page can hold more than a page will show,
for after each word he sets down a breath
of nothing that only the patient know.

He counts in pauses, a short and a long,
the way that a lamp would count in light,
and stacks them up like stones on a shelf
to carry them down when it turns to night.

So if you should find it, the salt-stained book,
do not just read what the letters say;
look past the last word on every line,
where the quiet keeper hid the way.

And if you hear only the sea in it,
be patient: the blank has a voice of its own.
It spells three letters and takes a breath,
then the lamp goes out, and the keeper is gone,
and the rocks keep the watch on their own.`;

const poemLines = POEM.split('\n').length;
const needed = code.split('L').length;
if (poemLines < needed) throw new Error(`the poem needs ${needed} lines, it has ${poemLines}`);
write('esolang-ftf-poem.txt', hideInCover(code, POEM).text);

// ---------- 3. interleaved: one visible character before every token ----------

const FILLER = 'Whitespace_hides_in_plain_sight,look_closer!';
let interleaved = '';
[...program].forEach((ch, i) => {
  interleaved += FILLER[i % FILLER.length] + ch;
});
write('esolang-ftf-interleaved.txt', `${interleaved}.`);

// ---------- 4. between markers inside prose ----------

write(
  'esolang-ftf-markers.txt',
  [
    'Lab notebook, entry 12.',
    'The signal came back on the third try, so I copied it below between the two markers.',
    `BEGIN${program}END`,
    'After that the line went quiet again. Nothing else to report today.',
    '',
  ].join('\n'),
);
