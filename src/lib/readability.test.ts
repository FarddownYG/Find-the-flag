import { describe, expect, it } from 'vitest';
import { rotate } from '../tools/crypto/caesar';
import {
  collocations,
  foldAccents,
  isFunctionWord,
  orderFit,
  phraseFit,
  readability,
  segmentWords,
  wordLikeness,
  wordRank,
  wordSplit,
} from './readability';
import { EN_COLLOCATIONS, FR_COLLOCATIONS } from './wordlists/collocations';
import { EN_WORDS } from './wordlists/en';
import { FR_WORDS } from './wordlists/fr';

const rot13 = (s: string) => rotate(s, 13, 'letters');

const score = (s: string) => readability(s).score;

// The (apocryphal) George Sand reply to Alfred de Musset — 19th century, public domain.
const SAND = [
  'Cette grande faveur que votre ardeur réclame',
  'Nuit peut-être à l’honneur mais répond à ma flamme.',
];
const firstWords = SAND.map((l) => l.split(/\s+/)[0]).join(' ');
const lastWords = SAND.map((l) => l.split(/\s+/).at(-1)).join(' ');

describe('readability — acceptance', () => {
  it('ranks the Sand acrostic far above the line endings', () => {
    expect(firstWords).toBe('Cette Nuit');
    const hit = readability(firstWords);
    expect(hit.score).toBeGreaterThanOrEqual(60);
    expect(hit.lang).toBe('fr');
    expect(score('réclame flamme')).toBeLessThanOrEqual(hit.score - 15);
    expect(score(lastWords)).toBeLessThanOrEqual(hit.score - 15);
  });

  it('prefers the acrostic phrase over the other word columns of the poem', () => {
    const lines = SAND.map((l) => l.split(/\s+/));
    const hit = score(firstWords);
    for (let n = 1; n < 8; n++) {
      const column = lines.map((w) => w[Math.min(n, w.length - 1)]).join(' ');
      // "que l’honneur" (4th words) is a genuine French fragment: no grammar check can rule it out.
      if (column === 'que l’honneur') continue;
      expect(score(column), column).toBeLessThan(hit - 10);
    }
  });

  it('reads the Musset acrostic', () => {
    expect(score('Quand Voulez vous que je couche avec vous')).toBeGreaterThanOrEqual(75);
  });

  it('segments spaceless French', () => {
    const a = readability('CETTENUIT');
    expect(a.score).toBeGreaterThanOrEqual(55);
    expect(a.segmented).toBe('cette nuit');
    expect(a.lang).toBe('fr');
    const b = readability('QUANDVOULEZVOUSQUEJECOUCHEAVECVOUS');
    expect(b.score).toBeGreaterThanOrEqual(70);
    expect(b.segmented).toBe('quand voulez vous que je couche avec vous');
  });

  it('reads and segments English', () => {
    const a = readability('meet at noon');
    expect(a.score).toBeGreaterThanOrEqual(60);
    expect(a.lang).toBe('en');
    const b = readability('MEETATNOON');
    expect(b.score).toBeGreaterThanOrEqual(50);
    expect(b.segmented).toBe('meet at noon');
    expect(b.lang).toBe('en');
  });

  it.each([
    'CN',
    'QVVQJCAV',
    'xqzvbkwplm',
    'ZmxhZ3t0ZXN0fQ==',
    '01100110 01101100',
    'Cgfqvarnpàlmràmf',
  ])('scores garbage %j at most 20', (s) => {
    expect(score(s)).toBeLessThanOrEqual(20);
  });

  it('reads flags, real sentences, and rejects ROT13 and lone words', () => {
    expect(score('flag{hidden_message}')).toBeGreaterThanOrEqual(60);
    const fr = 'Le marché ouvre tous les samedis matin sur la place de la mairie.';
    const en = 'The library is open every weekday from nine to five.';
    expect(score(fr)).toBeGreaterThanOrEqual(70);
    expect(readability(fr).lang).toBe('fr');
    expect(score(en)).toBeGreaterThanOrEqual(70);
    expect(readability(en).lang).toBe('en');
    expect(score(rot13(en))).toBeLessThanOrEqual(25);
    expect(score(rot13('Visitors can borrow up to six books at a time.'))).toBeLessThanOrEqual(25);
    expect(score('the')).toBeLessThanOrEqual(40);
  });
});

/** Fastest of a few runs, in ms: the least noisy measure on a busy machine. */
function fastest(fn: () => void, runs = 5): number {
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

describe('readability — performance', () => {
  // Scaling, not wall-clock budgets: four times the input must cost about four times as much
  // (a quadratic step would cost sixteen), whatever the machine's load.
  const prose =
    'Le marché ouvre tous les samedis matin sur la place de la mairie. On y trouve des ' +
    'légumes de saison, du fromage et du pain frais. Les habitants viennent souvent en ' +
    'famille et restent jusqu’à midi. The library is open every weekday from nine to five. ' +
    'Visitors can borrow up to six books at a time. ';

  it('scores prose in linear time', () => {
    const text = (n: number) => prose.repeat(Math.ceil(n / prose.length)).slice(0, n);
    readability(text(100)); // builds the dictionaries
    const small = fastest(() => readability(text(2000)));
    const large = fastest(() => readability(text(8000)));
    expect(large).toBeLessThan(8 * small + 5);
  });

  it('segments letters in linear time', () => {
    const letters = (n: number) => 'quandvoulezvousquejecoucheavecvous'.repeat(n / 30).slice(0, n);
    segmentWords('warmup', 'fr');
    const small = fastest(() => segmentWords(letters(500), 'fr'));
    const large = fastest(() => segmentWords(letters(2000), 'fr'));
    expect(large).toBeLessThan(8 * small + 5);
    expect(segmentWords(letters(300), 'fr').coverage).toBeGreaterThan(0.95);
  });
});

describe('readability — phrases', () => {
  it('scores how neighbouring words fit by class', () => {
    expect(readability('Cette Nuit').coherence).toBe(1);
    expect(readability('Quand voulez vous que je couche avec vous').coherence).toBeGreaterThan(0.8);
    // Function words in a row: no phrase, whatever the dictionary says.
    expect(readability('Je Le Dans Et').coherence).toBeLessThan(0.45);
    expect(readability('In The We And At To').coherence).toBeLessThan(0.45);
    expect(phraseFit(0.9)).toBe(1);
    expect(phraseFit(0.4)).toBe(0);
  });

  it('counts set phrases with a content word', () => {
    expect(readability('Cette Nuit').attested).toBe(1);
    expect(readability('Cette Garde').attested).toBe(0);
    expect(readability('Meet me at midnight').attested).toBe(2);
    expect(readability('send help').attested).toBe(1);
    expect(readability('de la').attested).toBe(0);
  });

  it('reads the words of the other language with their own grammar', () => {
    // "of" and "with" are English prepositions, not unknown content words: "of with" is no
    // phrase whichever language the sentence is read in.
    const mixed = readability('Je mange of with');
    expect(mixed.coherence).toBeLessThan(0.6);
    expect(readability('Je mange of with', ['fr']).coherence).toBeGreaterThan(mixed.coherence);
  });

  it('values a split into long words over a split into short ones', () => {
    expect(readability('SENDHELP').score).toBeGreaterThan(readability('airseedoaeat').score);
    expect(readability('HELLOWORLD').score).toBeGreaterThan(readability('igetpeai').score + 10);
  });

  it('does not split an unknown word of a sentence into fragments', () => {
    // "gather" is missing from the list; it must not become "g at her" and drag the sentence.
    const r = readability('At night we gather close beside the stove');
    expect(r.words).toContain('gather');
    expect(r.score).toBeGreaterThan(50);
    expect(r.score).toBeGreaterThan(
      readability('At night we gxther close beside the stove').score - 5,
    );
  });
});

describe('collocation lists', () => {
  it.each([
    ['fr', FR_COLLOCATIONS],
    ['en', EN_COLLOCATIONS],
  ] as const)(
    '%s: two words each, one of them not a function word, no duplicates',
    (lang, list) => {
      const entries = list
        .split(',')
        .map((e) => e.trim())
        .filter(Boolean);
      expect(entries.length).toBeGreaterThan(250);
      const keys = entries.map((e) => (foldAccents(e).match(/[a-z]+/g) ?? []).join(' '));
      for (const [i, k] of keys.entries()) expect(k.split(' '), entries[i]).toHaveLength(2);
      expect(new Set(keys).size).toBe(keys.length);
      expect(collocations(lang).size).toBe(keys.length);
      for (const e of entries) {
        // Counted only when one word is not a function word: a pair of function words is dead.
        expect(readability(e, [lang]).attested, e).toBe(1);
      }
    },
  );
});

describe('readability — details', () => {
  it('handles accents, apostrophes and case', () => {
    const a = readability('l’honneur');
    expect(a.lang).toBe('fr');
    expect(a.coverage).toBe(1);
    expect(a.words).toEqual(['l', 'honneur']);
    expect(readability('LHONNEUR').segmented).toBe("l'honneur");
    expect(score("L'ÉTÉ EST CHAUD")).toBe(score("l'été est chaud"));
    expect(score('Ceci est un message caché')).toBeGreaterThanOrEqual(70);
    expect(score('aujourd’hui il fait beau')).toBeGreaterThanOrEqual(70);
    expect(readability('jetaimemonamour').segmented).toBe("je t'aime mon amour");
  });

  it('penalises phrases that end on a preposition or article, accents respected', () => {
    expect(score('Je suis là')).toBeGreaterThan(score('je suis la') + 10);
    expect(score('faveur à')).toBeLessThan(score('Cette Nuit') - 10);
    expect(score('I love the')).toBeLessThan(score('I love you') - 10);
    // Without accents "la" may be "là": a segmented reading is not penalised.
    expect(readability('JESUISLA').segmented).toBe('je suis la');
    expect(score('JESUISLA')).toBeGreaterThanOrEqual(55);
  });

  it('handles English contractions', () => {
    const r = readability("It's a trap, don't go there!");
    expect(r.lang).toBe('en');
    expect(r.coverage).toBe(1);
    expect(r.score).toBeGreaterThanOrEqual(70);
  });

  it('accepts mixed French / English text', () => {
    const r = readability('Le hacker a trouvé the hidden flag dans le fichier');
    expect(r.lang).toBe('fr');
    expect(r.coverage).toBeGreaterThan(0.9);
    expect(r.score).toBeGreaterThanOrEqual(60);
    // Restricting the languages disables the foreign-word fallback.
    expect(readability('the hidden flag', ['fr']).score).toBeLessThan(score('the hidden flag'));
  });

  it('splits snake_case, camelCase and flag braces', () => {
    expect(readability('hiddenMessageHere').words).toEqual(['hidden', 'message', 'here']);
    expect(readability('HELLO_WORLD').words).toEqual(['hello', 'world']);
    expect(readability('flag{hidden_message}').words).toEqual(['flag', 'hidden', 'message']);
    // Unknown flag prefixes (event names) are ignored rather than counted as gibberish.
    expect(readability('CTF{this_is_fine}').words).toEqual(['this', 'is', 'fine']);
    expect(readability('flag{cettenuit}').segmented).toBe('flag cette nuit');
    // Odd casing is not camelCase.
    expect(readability('tHiS iS a TeSt').words).toEqual(['this', 'is', 'a', 'test']);
  });

  it('keeps the right reading of every Caesar shift on top', () => {
    const shift = (s: string, k: number) =>
      s.replace(/[A-Z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 65 + k) % 26) + 65));
    for (const plain of ['MEETATNOON', 'CETTENUIT']) {
      const real = score(plain);
      for (let k = 1; k < 26; k++) expect(score(shift(plain, k))).toBeLessThan(real - 30);
    }
  });

  it('returns an empty result when there are no letters', () => {
    expect(readability('')).toEqual({
      score: 0,
      lang: null,
      words: [],
      coverage: 0,
      stopwordShare: 0,
      segmented: null,
      coherence: 1,
      attested: 0,
      content: 0,
    });
    expect(readability('1234 5678 !!').lang).toBeNull();
  });

  it('is deterministic: memoised word lookups do not depend on what was scored before', () => {
    const texts = ['Cette Nuit', 'MEETATNOON', 'gathering stories', 'xqzv lhonneur', 'flag{a_b}'];
    const forward = texts.map((t) => readability(t));
    const backward = [...texts].reverse().map((t) => readability(t));
    expect(backward.reverse()).toEqual(forward);
    expect(forward.map((r) => r.score)).toEqual([
      67.7,
      66.4,
      forward[2]!.score,
      forward[3]!.score,
      forward[4]!.score,
    ]);
  });
});

describe('foldAccents / wordRank / segmentWords', () => {
  it('folds accents, ligatures and apostrophes', () => {
    expect(foldAccents('Élève à l’œuvre, Æsop, déjà')).toBe("eleve a l'oeuvre, aesop, deja");
    expect(foldAccents('ABC def')).toBe('abc def');
  });

  it('ranks frequent words first, accents ignored', () => {
    expect(wordRank('the', 'en')).toBe(0);
    expect(wordRank('de', 'fr')).toBe(0);
    expect(wordRank('ETE', 'fr')).toBe(wordRank('été', 'fr'));
    expect(wordRank('cette', 'fr')!).toBeLessThan(wordRank('flamme', 'fr')!);
    expect(wordRank('xqzv', 'en')).toBeNull();
  });

  it('segments and reports coverage', () => {
    expect(segmentWords('MEETATNOON', 'en')).toEqual({
      words: ['meet', 'at', 'noon'],
      coverage: 1,
    });
    expect(segmentWords('the quick brown fox', 'en').words).toEqual([
      'the',
      'quick',
      'brown',
      'fox',
    ]);
    const partial = segmentWords('xqzthecat', 'en');
    expect(partial.words).toEqual(['xqz', 'the', 'cat']);
    expect(partial.coverage).toBeCloseTo(6 / 9);
    expect(segmentWords('', 'fr')).toEqual({ words: [], coverage: 0 });
  });
});

describe('word lists', () => {
  it.each([
    ['en', EN_WORDS, /^[a-z]+$/],
    ['fr', FR_WORDS, /^[a-zàâäçéèêëîïôöùûüÿœæ]+$/],
  ] as const)('%s: ~5000 lowercase unique words', (_lang, list, shape) => {
    const words = list.split(/\s+/).filter(Boolean);
    expect(words.length).toBeGreaterThan(4500);
    expect(new Set(words).size).toBe(words.length);
    for (const w of words) expect(w).toMatch(shape);
  });
});

describe('unknown words, inflections, order and chance', () => {
  it('one rare word costs a sentence a little, not most of its score', () => {
    // "paillasson" is missing from the lists; it looks French, gibberish does not.
    expect(wordLikeness('paillasson', 'fr')).toBeGreaterThan(0.8);
    expect(wordLikeness('qzvk', 'fr')).toBe(0);
    expect(score('la cle est sous le paillasson')).toBeGreaterThan(55);
    expect(score('la cle est sous le qzvkxwjt')).toBeLessThan(40);
    // A word that only looks like one never counts on its own.
    expect(score('paillassonne')).toBeLessThan(25);
  });

  it('segments inflected forms and keeps camelCase only where the parts are words', () => {
    expect(segmentWords('HIDETHEKEYS', 'en').words).toEqual(['hide', 'the', 'keys']);
    expect(segmentWords('cachezlacle', 'fr').words).toEqual(['cachez', 'la', 'cle']);
    // An acrostic keeps the capital of a name it picked up: still "attack at noon".
    expect(readability('AttacKatnoon').segmented).toBe('attack at noon');
    expect(readability('userProfileService').words).toEqual(['user', 'profile', 'service']);
    // No loose rule inside a run of letters: "dug" + "ed" is not a word.
    expect(segmentWords('duged', 'en').coverage).toBeLessThan(1);
  });

  it('tells a line order from the same lines upside down', () => {
    const lines = ['il faut', 'tout brûler', 'avant minuit', 'sans laisser de traces'];
    const right = orderFit(lines);
    const wrong = orderFit([...lines].reverse());
    expect(right.fit - wrong.fit).toBeGreaterThan(0.05);
    expect(right.open).toBe(3);
    // After a full stop any order fits: those joins say nothing.
    expect(orderFit(['It rains.', 'We stay in.']).open).toBe(0);
  });

  it('measures how unlikely it is that letters split into words by chance', () => {
    const long = wordSplit('thecellardoor')!;
    expect(long.words).toEqual(['the', 'cellar', 'door']);
    expect(long.bits).toBeGreaterThan(12);
    expect(wordSplit('northgate')!.bits).toBeGreaterThan(wordSplit('runnow')!.bits);
    // A pick full of one letter splits easily: little surprise.
    expect(wordSplit('aaauaua')?.bits ?? 0).toBeLessThan(6);
    expect(wordSplit('xqzvkt')).toBeNull();
  });

  it('knows the function words of both languages', () => {
    expect(isFunctionWord('les')).toBe(true);
    expect(isFunctionWord('The')).toBe(true);
    expect(isFunctionWord('maison')).toBe(false);
  });
});
