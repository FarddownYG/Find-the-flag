// Prints the made-up ciphertexts used by the "Try" examples of the polygraphic cipher tools
// (Playfair family, Bifid / Trifid, Hill). Nothing here is a real challenge: the plaintexts are
// written for the examples and the keys are public demo values.
//
//   node scripts/gen-samples-polygraphic.mjs            all tools
//   node scripts/gen-samples-polygraphic.mjs playfair   one tool
//
// The ciphertexts are made with the tools' own encryption code (loaded through Vite), so the
// examples and the tools cannot drift apart; the unit tests check the same code against published
// test vectors. Paste the printed lines into the examples of the tool file when a text changes.
import { createServer } from 'vite';

const only = process.argv[2];

const vite = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
});
let mods;
try {
  mods = {
    square: await vite.ssrLoadModule('/src/tools/crypto/_square.ts'),
    playfair: await vite.ssrLoadModule('/src/tools/crypto/_playfair.ts'),
    bifid: await vite.ssrLoadModule('/src/tools/crypto/_bifid.ts'),
    hill: await vite.ssrLoadModule('/src/tools/crypto/_hill.ts'),
  };
} finally {
  await vite.close();
}

const lettersOf = (s) => s.replace(/[^A-Za-z]/g, '').length;
const print = (label, text) => console.log(`${label} (${lettersOf(text)} letters):\n${text}\n`);

if (!only || only === 'playfair') {
  const { toSymbols } = mods.square;
  const { buildLayout, pairUp, crypt } = mods.playfair;

  const playfair = (plain, key, kind = 'ij') => {
    const { pairs } = pairUp(toSymbols(kind, plain).symbols, 'playfair', kind, 'X');
    return crypt(buildLayout('playfair', kind, key, ''), 'encrypt', pairs)
      .map((d) => d.output)
      .join('');
  };

  const english =
    'The message you are reading was hidden by a square of twenty five letters and nothing else. ' +
    'Nobody gave you the key, so the computer tried thousands of squares, kept the ones that looked ' +
    'a little more like English, and slowly shook the rest of the letters into place. This is ' +
    'called annealing, because it works like metal that cools.';
  const french =
    "Personne ne vous a donné la clé de ce message, alors l'ordinateur a essayé des milliers de " +
    'carrés, gardé ceux qui ressemblaient un peu plus à du français, puis remis les dernières ' +
    'lettres en place une à une. Quand les mots apparaissent enfin, il suffit de recopier la clé ' +
    "dans l'outil pour lire tous les autres messages écrits avec elle.";

  print('playfair-solve-en  key FORGED STEEL', playfair(english, 'forged steel'));
  print(
    'playfair-solve-fr  key CLE ROUGE',
    playfair(french.normalize('NFD').replace(/\p{M}/gu, ''), 'cle rouge'),
  );

  // A different text and key for the browser test (e2e/playfair.spec.ts), not shown as an example.
  const e2e =
    'Nobody expected the old lighthouse to start blinking again after thirty years of darkness, but ' +
    'on the first night of spring the lamp turned by itself and swept its beam across the empty ' +
    'harbour. The villagers gathered on the quay with blankets and flasks of tea, whispering theories ' +
    "about wires, ghosts and a forgotten timer. Only the baker's daughter, who had climbed the tower " +
    'as a child, smiled and said that the key had never been lost.';
  print('playfair-e2e  key LANTERN LIGHT', playfair(e2e, 'lantern light'));
}

if (!only || only === 'bifid') {
  const { toSymbols } = mods.square;
  const { bifidGrid, trifidGrid, fractionate, joinBlocks } = mods.bifid;

  const bifid = (plain, key, period) =>
    joinBlocks(
      fractionate(bifidGrid('ij', key), toSymbols('ij', plain).symbols, period, 'encrypt'),
    );
  const trifid = (plain, key, extra, period) =>
    joinBlocks(fractionate(trifidGrid(extra, key), [...plain.toUpperCase()], period, 'encrypt'));

  print(
    'trifid-27th  key LIGHTHOUSE, period 0',
    trifid('meet+at+the+bridge', 'lighthouse', '+', 0),
  );
  const english =
    'The signal was sent at midnight from the old tower, and nobody on the coast could tell who ' +
    'had sent it. Three short flashes, a pause, then two long ones: the fishermen said it meant ' +
    'that the storm would turn before dawn, and for once they were right.';
  print('bifid-period  key LIGHTHOUSE, period 7', bifid(english, 'lighthouse', 7));
}

if (!only || only === 'hill') {
  const { HILL_ALPHABETS, applyBlocks, parseKey, readText, writeText } = mods.hill;
  const alphabet = HILL_ALPHABETS.az;

  /** Hill encryption of the letters of a text (padded with X), letters only. */
  const hill = (plain, key) => {
    const { matrix, n } = parseKey(key, alphabet);
    const { values } = readText(plain.replace(/[^A-Za-z]/g, ''), alphabet);
    while (values.length % n) values.push(alphabet.symbols.indexOf('X'));
    const out = applyBlocks(values, matrix, 26).flatMap((s) => s.output);
    return writeText([], out, alphabet, false);
  };

  const signal =
    'Every night the keeper of the old lighthouse raises a flag at dawn, but only he knows what ' +
    'the signal means, and he has never told anyone. Three nights in a row the same pattern came ' +
    'across the water, and on the fourth the lamp finally answered.';
  print('hill-known  3x3 key GYBNQKURP (known start EVERYNIGH)', hill(signal, 'GYBNQKURP'));
  // The first blocks of this start (THE SIG NAL) are linearly dependent mod 26 and mod 13.
  const dependent =
    'The signal flag is raised at dawn, but only the keeper of the old lighthouse knows what it means.';
  print(
    'hill-dependent  3x3 key GYBNQKURP (known start THESIGNAL)',
    hill(dependent, 'GYBNQKURP').slice(0, 66),
  );
  const crack =
    'Nobody remembers who built the bridge, but every spring the villagers repaint its railings ' +
    'and hang lanterns along the arches. On the first night the whole valley is lit, and travellers ' +
    'say that from the hill above it looks like a river of small stars flowing slowly toward the sea.';
  print('hill-crack  2x2 key 5 17 4 15 (FRE P)', hill(crack, '5 17 4 15'));
}
