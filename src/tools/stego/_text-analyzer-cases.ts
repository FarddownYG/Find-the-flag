/**
 * Reference cases for the text analyzer. Each one hides a message with one technique;
 * the analyzer must surface `expected` (accents and case ignored) among its top results.
 * `negative` cases contain nothing hidden: the analyzer must not claim a strong hit.
 */
import { baconEncodeBits } from '../crypto/bacon';
import { makeRng } from '../crypto/_classical';
import { embedPayload, encodePayload } from './_zerowidth';
import { encodeBinary, encodeSnow } from './whitespace';

export interface TextCase {
  name: string;
  technique: string;
  text: string;
  expected?: string;
  negative?: true;
  /**
   * The message is too short to prove anything on its own (a 4-letter word): it must rank in
   * the top 3 but is not required to stand out.
   */
  weak?: true;
}

export const TEXT_CASES: TextCase[] = [
  {
    // The (apocryphal) George Sand reply to Alfred de Musset — 19th century, public domain.
    name: 'Sand to Musset',
    technique: 'first word of each line',
    text: 'Cette grande faveur que votre ardeur réclame\nNuit peut-être à l’honneur mais répond à ma flamme.',
    expected: 'cette nuit',
  },
  {
    // The Musset poem the reply answers (same anecdote).
    name: 'Musset to Sand',
    technique: 'first word of each line',
    text: [
      'Quand je mets à vos pieds un éternel hommage,',
      'Voulez-vous qu’un instant je change de visage ?',
      'Vous avez capturé les sentiments d’un cœur',
      'Que pour vous adorer forma le Créateur.',
      'Je vous chéris, amour, et ma plume en délire',
      'Couche sur le papier ce que je n’ose dire.',
      'Avec soin de mes vers lisez les premiers mots,',
      'Vous saurez quel remède apporter à mes maux.',
    ].join('\n'),
    expected: 'quand voulez vous que je couche avec vous',
  },
  {
    name: 'English acrostic',
    technique: 'first letter of each line',
    text: [
      'Many travellers pass along this road,',
      'each of them carrying a heavy load.',
      'Evening falls and the lanterns glow,',
      'tired feet keep moving slow.',
      'At the inn the fire is warm,',
      'travellers shelter from the storm.',
      'Night is long but morning comes,',
      'over the hills the first light hums,',
      'off they go when the cock has crowed,',
      'now the dust is on the road.',
    ].join('\n'),
    expected: 'meet at noon',
  },
  {
    name: 'English telestich',
    technique: 'last letter of each line',
    text: [
      'We walked along the river path',
      'and stopped to rest beside the stone',
      'where children used to fill a pail',
      'of water for the village shop',
      'and told of storms in far Hawaii.',
      'The evening light was soft as glass',
      'upon the hills beyond the attic,',
      'a tune about a lost tornado,',
      'the air was cool, the water calm;',
      'we hailed a passing taxi',
      'that took us home beneath the moon',
      'and left us at the gate, still laughing',
    ].join('\n'),
    expected: 'help is coming',
  },
  {
    name: 'Plain French prose',
    technique: 'none',
    text: [
      'Le marché ouvre tous les samedis matin sur la place de la mairie.',
      'On y trouve des légumes de saison, du fromage et du pain frais.',
      'Les habitants viennent souvent en famille et restent jusqu’à midi.',
    ].join('\n'),
    negative: true,
  },
  {
    name: 'Plain English prose',
    technique: 'none',
    text: [
      'The library is open every weekday from nine to five.',
      'Visitors can borrow up to six books at a time.',
      'Please return them before the due date printed on the receipt.',
    ].join('\n'),
    negative: true,
  },
  {
    // Victor Hugo, « Demain, dès l’aube… » (1856), public domain: a poem with no acrostic.
    name: 'Hugo, Demain dès l’aube',
    technique: 'none',
    text: [
      'Demain, dès l’aube, à l’heure où blanchit la campagne,',
      'Je partirai. Vois-tu, je sais que tu m’attends.',
      'J’irai par la forêt, j’irai par la montagne.',
      'Je ne puis demeurer loin de toi plus longtemps.',
      '',
      'Je marcherai les yeux fixés sur mes pensées,',
      'Sans rien voir au dehors, sans entendre aucun bruit,',
      'Seul, inconnu, le dos courbé, les mains croisées,',
      'Triste, et le jour pour moi sera comme la nuit.',
      '',
      'Je ne regarderai ni l’or du soir qui tombe,',
      'Ni les voiles au loin descendant vers Harfleur,',
      'Et quand j’arriverai, je mettrai sur ta tombe',
      'Un bouquet de houx vert et de bruyère en fleur.',
    ].join('\n'),
    negative: true,
  },
  {
    // Shakespeare, Sonnet 18 (1609), public domain: verse lines, no hidden message.
    name: 'Shakespeare, Sonnet 18',
    technique: 'none',
    text: [
      'Shall I compare thee to a summer’s day?',
      'Thou art more lovely and more temperate:',
      'Rough winds do shake the darling buds of May,',
      'And summer’s lease hath all too short a date;',
      'Sometime too hot the eye of heaven shines,',
      'And often is his gold complexion dimm’d;',
      'And every fair from fair sometime declines,',
      'By chance or nature’s changing course untrimm’d;',
      'But thy eternal summer shall not fade,',
      'Nor lose possession of that fair thou ow’st;',
      'Nor shall death brag thou wander’st in his shade,',
      'When in eternal lines to time thou grow’st:',
      'So long as men can breathe or eyes can see,',
      'So long lives this, and this gives life to thee.',
    ].join('\n'),
    negative: true,
  },
];

// ---------------------------------------------------------------------------------------------
// Regression cases from independent verification runs. Every text is original (or a 19th-century
// public-domain line); the lists, letters and logs are invented. Kept apart from TEXT_CASES so
// the shipped tool, which takes its examples from TEXT_CASES, does not bundle them.

/** Zero-width binary: U+200B = 0, U+200C = 1, 8 bits per byte (the zero-width tool's scheme). */
function zeroWidthBits(secret: string): string {
  let out = '';
  for (const ch of secret) {
    const byte = ch.charCodeAt(0);
    for (let b = 7; b >= 0; b--) out += (byte >> b) & 1 ? '\u200c' : '\u200b';
  }
  return out;
}

const lines = (...l: string[]) => l.join('\n');

const BICYCLE_ARTICLE = [
  'The bicycle is one of those inventions that seems so obvious in hindsight that it is hard to believe it took so long to appear. Two wheels, a frame, a seat and a way to push: none of it required a scientific breakthrough, and yet the first machines that looked anything like a modern bicycle only rolled out in the nineteenth century.',
  'The earliest versions had no pedals at all. Riders sat on a wooden beam between two wheels and pushed against the ground with their feet, a little like a child on a balance bike today. They were heavy, uncomfortable and mostly a curiosity for wealthy young men who wanted to be seen in the park on a Sunday afternoon.',
  'Pedals came next, fixed directly to the front wheel. Because one turn of the pedals meant one turn of the wheel, makers built the front wheel larger and larger to go faster, until riders were perched high above the road on machines that threw them forward at the slightest bump. Accidents were common, and the machines kept their reputation as a sport for the daring.',
  'The real change was the chain. Once the pedals could drive the rear wheel through a set of gears, both wheels could be the same modest size and the rider could sit low and safe. The so-called safety bicycle spread quickly, and within a few years it had become a practical way for ordinary people to travel to work, to visit relatives in the next village or simply to enjoy the countryside.',
  'Pneumatic tyres made the ride far smoother. Before them, solid rubber or even iron rims rattled every bone on cobbled streets. With air inside the tyre, the bicycle suddenly became comfortable enough for long distances, and touring clubs began to organise trips across whole regions, publishing maps and guides for their members.',
  'The bicycle also changed daily life in less obvious ways. It gave many people, and women in particular, a new independence: they could go where they wanted without waiting for a carriage or asking for permission. Clothing adapted, roads improved, and repair shops opened in towns that had never needed a mechanic before.',
  'In the twentieth century the car took over much of the road, and in many countries the bicycle was pushed aside as a toy or a tool for people who could not afford anything better. Yet it never disappeared. In flat cities with short distances, it remained the fastest way to get around, and some places built entire networks of protected lanes around it.',
  'Today the bicycle is enjoying a quiet revival. Electric assistance has made hills and long commutes manageable for riders who would never have tried them, while cargo bikes carry children, groceries and even furniture through busy streets. Cities that once planned only for cars now count bicycles at their junctions and redesign crossings to make them safer.',
  'Perhaps the most remarkable thing about the bicycle is how little its basic shape has changed. A rider from the end of the nineteenth century would recognise a modern frame at once, and could probably ride it without any instruction. Few machines have been so right so early, and fewer still have stayed useful for so long.',
].join('\n\n');

export const REGRESSION_CASES: TextCase[] = [
  {
    name: 'FR prose',
    technique: 'ordinary text (negative)',
    text: 'Ce matin, le marché du village était particulièrement animé. Les maraîchers avaient installé leurs étals dès l’aube, et les premières fraises de la saison attiraient déjà une petite foule. Un peu plus loin, le boulanger distribuait des morceaux de brioche aux enfants qui passaient. Vers midi, la place s’est vidée peu à peu, et il ne restait plus que quelques cagettes vides près de la fontaine.',
    negative: true,
  },
  {
    name: 'EN prose',
    technique: 'ordinary text (negative)',
    text: 'Last weekend we finally repaired the old garden shed. The roof had been leaking for months, so we replaced the felt and added a new gutter along the back. My neighbour lent us a ladder and stayed for coffee once the work was done. By Sunday evening the door closed properly for the first time in years. Next spring we plan to paint it dark green and put a small bench beside it.',
    negative: true,
  },
  {
    name: 'FR rhyming poem 8 lines (no acrostic)',
    technique: 'ordinary verse (negative)',
    text: lines(
      'Le soir descend doucement sur la plaine,',
      'Et le berger rassemble son troupeau ;',
      'Au loin s’éteint le chant de la fontaine,',
      'Le vent du nord se glisse sous le hameau.',
      'La lune monte au-dessus des collines,',
      'Sur les toits gris la fumée se défait,',
      'Un chien aboie derrière les églantines,',
      'Et le village s’endort dans la paix.',
    ),
    negative: true,
  },
  {
    name: 'EN rhyming poem 8 lines (no acrostic)',
    technique: 'ordinary verse (negative)',
    text: lines(
      'The morning light came softly through the trees,',
      'And painted gold the meadow and the stream;',
      'A blackbird sang above the humming bees,',
      'While cattle wandered slowly in a dream.',
      'The farmer walked along the narrow lane,',
      'His dog ran on before him through the dew;',
      'He watched the clouds and wondered if the rain',
      'Would hold away until the day was through.',
    ),
    negative: true,
  },
  {
    name: 'EN song verses with refrain',
    technique: 'ordinary verse (negative)',
    text: lines(
      'Oh, the river runs so wide,',
      'Oh, the river runs so deep,',
      'And the boats go drifting by',
      'While the little children sleep.',
      'Sing along, sing along,',
      'Let the water carry our song,',
      'Sing along, sing along,',
      'All the summer evening long.',
      'Oh, the hills are turning blue,',
      'Oh, the sun is going down,',
      'And the lanterns one by one',
      'Light the windows of the town.',
    ),
    negative: true,
  },
  {
    name: 'FR chanson with refrain (short lines)',
    technique: 'ordinary verse (negative)',
    text: lines(
      'Il pleut sur la ville,',
      'Il pleut sur mon cœur,',
      'La rue est tranquille,',
      'Je chante en douceur.',
      'Tourne, tourne la ronde,',
      'Tourne autour du puits,',
      'Tourne tout le monde',
      'Jusqu’à la fin de la nuit.',
    ),
    negative: true,
  },
  {
    name: 'FR shopping list',
    technique: 'ordinary list (negative)',
    text: lines(
      'Lait',
      'Pain',
      'Œufs',
      'Beurre',
      'Tomates',
      'Pommes de terre',
      'Fromage râpé',
      'Café',
      'Papier toilette',
    ),
    negative: true,
  },
  {
    name: 'EN shopping list',
    technique: 'ordinary list (negative)',
    text: lines(
      '- 2 apples',
      '- milk (1 L)',
      '- bread',
      '- eggs x12',
      '- coffee beans',
      '- olive oil',
      '- toothpaste',
      '- dish soap',
    ),
    negative: true,
  },
  {
    name: 'CTF challenge description',
    technique: 'ordinary text (negative)',
    text: lines(
      'Welcome to the Crypto 101 challenge!',
      'Our intern encrypted the admin password with a homemade cipher and lost the key.',
      'Can you recover the message? The flag format is FTF{...}.',
      'Hint: frequency analysis is your friend.',
      'Author: n0b0dy | Points: 150 | Solves: 42',
    ),
    negative: true,
  },
  {
    name: 'TypeScript snippet',
    technique: 'code (negative)',
    text: lines(
      'export function debounce<T extends (...args: unknown[]) => void>(fn: T, ms = 200) {',
      '  let timer: ReturnType<typeof setTimeout> | undefined;',
      '  return (...args: Parameters<T>) => {',
      '    if (timer) clearTimeout(timer);',
      '    timer = setTimeout(() => fn(...args), ms);',
      '  };',
      '}',
    ),
    negative: true,
  },
  {
    name: 'Python snippet with tabs',
    technique: 'code (negative)',
    text: 'def fib(n):\n\tif n < 2:\n\t\treturn n\n\treturn fib(n - 1) + fib(n - 2)\n\n\nfor i in range(10):\n\tprint(i, fib(i))',
    negative: true,
  },
  {
    name: 'Log excerpt',
    technique: 'logs (negative)',
    text: lines(
      '2024-03-11T08:15:02Z INFO  [api] GET /v1/users/42 200 12ms req_id=7f3a9c2e ip=192.0.2.17',
      '2024-03-11T08:15:03Z INFO  [api] POST /v1/sessions 201 48ms req_id=1b8d44f0 ip=198.51.100.4',
      '2024-03-11T08:15:05Z WARN  [db] slow query 812ms table=orders req_id=9e02c7aa',
      '2024-03-11T08:15:07Z INFO  [api] GET /v1/orders?page=2 200 35ms req_id=c4d1e9b3 ip=192.0.2.17',
      '2024-03-11T08:15:09Z ERROR [worker] job 5531 failed: timeout after 30000ms req_id=0a7f6e21',
    ),
    negative: true,
  },
  {
    name: 'JSON blob',
    technique: 'structured data (negative)',
    text: lines(
      '{',
      '  "id": "3f2b8c1e-9a47-4d2e-b6f1-0c5e7a9d8b34",',
      '  "sha1": "2fd4e1c67a2d28fced849ee1bb76e7391b93eb12",',
      '  "created": "2023-11-05T10:22:00Z",',
      '  "tags": ["backup", "weekly"],',
      '  "size": 1048576,',
      '  "ok": true',
      '}',
    ),
    negative: true,
  },
  {
    name: 'Tweet with emojis (ZWJ family + VS16)',
    technique: 'emoji with legit zero-width joiners (negative)',
    text: 'Week-end en famille 👨\u200d👩\u200d👧\u200d👦 au bord de la mer 🌊☀\ufe0f trop bien !! 😍🙌 #vacances #bonheur',
    negative: true,
  },
  {
    name: 'Names and numbers (meeting minutes)',
    technique: 'ordinary text (negative)',
    text: 'Réunion du 12 mars 2024 : présents Jean Dupont, Sophie Bernard, Paul Martin. Budget voté : 12 500 € pour le second trimestre, dont 3 200 € de matériel. Prochaine réunion le 9 avril à 10 h 30, salle 204. Points à préparer : devis du traiteur, planning des congés, inventaire du stock.',
    negative: true,
  },
  {
    name: 'One line',
    technique: 'very short (negative)',
    text: 'See you tomorrow at the station.',
    negative: true,
  },
  { name: 'Two words', technique: 'very short (negative)', text: 'Bonjour Marie', negative: true },
  { name: 'One word', technique: 'very short (negative)', text: 'hello', negative: true },
  {
    name: 'Long 5 KB article (EN, 9 paragraphs)',
    technique: 'long prose (negative)',
    text: BICYCLE_ARTICLE,
    negative: true,
  },
  {
    name: 'FR typography with NBSP / NNBSP',
    technique: 'legit unusual spaces (negative)',
    text: 'Attention\u00a0: le train de 8\u00a0h part du quai 3\u202f! Avez-vous votre billet\u202f? Les contrôleurs passeront entre Lyon et Dijon\u00a0; gardez-le à portée de main. Prix\u00a0: 45\u00a0€, «\u00a0aller simple\u00a0».',
    negative: true,
  },
  {
    name: 'Typewriter double spaces after periods',
    technique: 'legit double spaces (negative)',
    text: 'The meeting starts at nine.  Please bring your notes.  Coffee will be served.  We should finish by noon.  Thanks for coming.',
    negative: true,
  },
  {
    name: 'Markdown hard breaks (2 trailing spaces)',
    technique: 'legit trailing whitespace (negative)',
    text: 'Roses are red,  \nViolets are blue,  \nSugar is sweet,  \nAnd so are you.',
    negative: true,
  },
  {
    name: 'CamelCase brand names',
    technique: 'legit odd case (negative)',
    text: 'I bought an iPhone and a MacBook, then installed JavaScript tools from GitHub on my iPad. Later we grabbed lunch at McDonald’s and watched a few YouTube videos about PowerPoint tricks.',
    negative: true,
  },
  {
    name: 'All caps shout',
    technique: 'legit all-caps (negative)',
    text: 'ATTENTION TOUT LE MONDE : LA RÉUNION DE CE SOIR EST ANNULÉE !',
    negative: true,
  },
  {
    name: 'SHA-256 checksum in text',
    technique: 'hex noise (negative)',
    text: 'Download checksum (SHA-256): e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855. Verify it before installing.',
    negative: true,
  },
  {
    name: 'git log --oneline',
    technique: 'hex noise (negative)',
    text: lines(
      'a1b2c3d Fix login redirect',
      '9f8e7d6 Add dark mode toggle',
      '0c1d2e3 Bump dependencies',
      '4b5a6f7 Update README',
      'dead123 Remove unused helper',
    ),
    negative: true,
  },
  {
    name: 'Numbers list',
    technique: 'decimal noise (negative)',
    text: 'Scores: 12 45 78 90 33 21 67 88 54 101 72',
    negative: true,
  },
  {
    name: 'Mixed scripts (Russian / Greek words)',
    technique: 'legit non-Latin words (negative)',
    text: 'Le mot russe « спасибо » veut dire merci, et le grec « ευχαριστώ » aussi. On dit « danke » en allemand.',
    negative: true,
  },
  {
    name: 'Formal letter FR',
    technique: 'ordinary text (negative)',
    text: lines(
      'Madame, Monsieur,',
      'Je vous prie de trouver ci-joint mon dossier de candidature pour le poste de technicien de maintenance.',
      'Je reste à votre disposition pour tout renseignement complémentaire.',
      'Veuillez agréer, Madame, Monsieur, l’expression de mes salutations distinguées.',
      'Jean Dupont',
    ),
    negative: true,
  },
  {
    name: 'Haiku-like 3 lines EN',
    technique: 'ordinary verse (negative)',
    text: lines('Old pond in the dusk', 'a frog leaps into the dark', 'ripples, then silence'),
    negative: true,
  },
  {
    name: 'FR couplet, Musset shape, nothing hidden',
    technique: 'ordinary verse (negative)',
    text: lines(
      'Le vent se lève sur la mer immense et grise,',
      'Et les bateaux rentrent au port avant la brise.',
    ),
    negative: true,
  },
  {
    name: 'Quote with author',
    technique: 'ordinary text (negative)',
    text: lines('"Well begun is half done."', '— an old proverb, often quoted on posters'),
    negative: true,
  },
  {
    name: 'Q1 FR quatrain',
    technique: 'ordinary verse (negative)',
    text: lines(
      'Je marche seul le long de la rivière,',
      'Le ciel est bas et le vent est léger ;',
      'Dans le jardin fleurit la primevère,',
      'Et le soleil se couche sur le verger.',
    ),
    negative: true,
  },
  {
    name: 'Q2 FR quatrain',
    technique: 'ordinary verse (negative)',
    text: lines(
      'Tu dors encore, la maison est tranquille,',
      'Le café chauffe et la radio se tait ;',
      'Par la fenêtre on voit dormir la ville,',
      'Et sur la table attend le pain au lait.',
    ),
    negative: true,
  },
  {
    name: 'Q3 FR quatrain',
    technique: 'ordinary verse (negative)',
    text: lines(
      'Il était une fois un vieux marin,',
      'Qui racontait la mer à ses enfants ;',
      'De port en port, il cherchait son chemin,',
      'Mais il rentrait toujours avec le vent.',
    ),
    negative: true,
  },
  {
    name: 'Q4 FR couplet',
    technique: 'ordinary verse (negative)',
    text: lines(
      "Le temps s'enfuit comme l'eau sous les ponts,",
      'Et nous restons à compter les saisons.',
    ),
    negative: true,
  },
  {
    name: 'Q5 FR couplet',
    technique: 'ordinary verse (negative)',
    text: lines('Mon cœur se serre en voyant la mer grise,', 'Ton souvenir revient avec la brise.'),
    negative: true,
  },
  {
    name: "Q6 FR couplet starting 'Cette' (Musset mirror)",
    technique: 'ordinary verse (negative), adversarial twin of the test case',
    text: lines('Cette maison que mon père a bâtie', "Garde l'odeur des étés de ma vie."),
    negative: true,
  },
  {
    name: 'Q7 EN quatrain',
    technique: 'ordinary verse (negative)',
    text: lines(
      'I wandered down the hill at break of day,',
      'The grass was wet and shining in the sun;',
      'My dog ran on ahead along the way,',
      'And I was glad the walking had begun.',
    ),
    negative: true,
  },
  {
    name: 'Q8 EN quatrain',
    technique: 'ordinary verse (negative)',
    text: lines(
      'We sat beside the fire and told our tales,',
      'Of ships that sailed beyond the northern sea;',
      'The wind outside was singing in the rails,',
      'But we were warm with bread and cups of tea.',
    ),
    negative: true,
  },
  {
    name: 'Q9 EN couplet',
    technique: 'ordinary verse (negative)',
    text: lines(
      'The night is long and every star is bright,',
      'So let us walk together in the light.',
    ),
    negative: true,
  },
  {
    name: 'Q10 EN couplet',
    technique: 'ordinary verse (negative)',
    text: lines(
      'Good friends are rare, so keep them close and near,',
      'For they will stay when others disappear.',
    ),
    negative: true,
  },
  {
    name: 'Q11 FR 6 lines',
    technique: 'ordinary verse (negative)',
    text: lines(
      'Au bord du lac les arbres se reflètent,',
      'Les canards glissent sur l’eau sans un bruit ;',
      'On entend rire au loin quelques fillettes,',
      'Puis le silence revient avec la nuit.',
      'Je reste assis sur le vieux banc de pierre,',
      'Et je m’endors en comptant les étoiles.',
    ),
    negative: true,
  },
  {
    name: 'Q12 EN 6 lines',
    technique: 'ordinary verse (negative)',
    text: lines(
      'In winter time the roads are white with snow,',
      'The children build a castle in the yard;',
      'We hear the trains go rumbling far below,',
      'And every window glitters like a card.',
      'At night we gather close beside the stove',
      'To share our stories and the bread we baked.',
    ),
    negative: true,
  },
  {
    name: 'Hard-wrapped FR email',
    technique: 'ordinary text with hard line wraps (negative)',
    text: lines(
      'Bonjour à tous,',
      'je vous confirme que la réunion de demain est',
      'maintenue à 14 h dans la salle du deuxième étage.',
      'Merci d’apporter vos chiffres du mois et, si',
      'possible, une courte liste des points bloquants',
      'pour que l’on puisse avancer rapidement.',
      'Bonne fin de journée,',
      'Claire',
    ),
    negative: true,
  },
  {
    name: 'Hard-wrapped EN email',
    technique: 'ordinary text with hard line wraps (negative)',
    text: lines(
      'Hi team,',
      'just a reminder that the office will be closed',
      'on Friday for maintenance. Please take your',
      'laptops home on Thursday evening and make sure',
      'that your desks are clear so the cleaners can',
      'work around them.',
      'Thanks,',
      'Sam',
    ),
    negative: true,
  },
  {
    name: 'To-do list',
    technique: 'ordinary list (negative), input in disguise',
    text: lines(
      'Call the plumber',
      'Pay the electricity bill',
      'Buy a birthday card',
      'Book train tickets',
      'Water the plants',
      'Send the report',
    ),
    negative: true,
  },
  {
    name: 'Ingredients list',
    technique: 'ordinary list (negative)',
    text: lines(
      '200 g flour',
      '3 eggs',
      '50 cl milk',
      '1 pinch salt',
      '2 tbsp sugar',
      '30 g butter',
    ),
    negative: true,
  },
  {
    name: 'Names list',
    technique: 'ordinary list (negative)',
    text: lines('Alice', 'Bruno', 'Chloé', 'David', 'Emma', 'Farid', 'Gabriel'),
    negative: true,
  },
  {
    name: 'FR menu',
    technique: 'ordinary list (negative)',
    text: lines(
      'Entrée : salade de chèvre chaud',
      'Plat : poulet rôti, pommes de terre',
      'Fromage : comté affiné',
      'Dessert : tarte aux pommes',
      'Café ou thé',
    ),
    negative: true,
  },
  {
    name: 'Colours list (one word per line)',
    technique: 'ordinary list (negative)',
    text: lines('red', 'orange', 'yellow', 'green', 'blue', 'indigo', 'violet'),
    negative: true,
  },
  {
    name: 'FR days list (one word per line)',
    technique: 'ordinary list (negative)',
    text: lines('lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'),
    negative: true,
  },
  {
    name: 'POS Musset / Sand (mandatory case)',
    technique: 'first word of each line acrostic',
    text: lines(
      'Cette grande faveur que votre ardeur réclame',
      "Nuit peut-être à l'honneur mais répond à ma flamme.",
    ),
    expected: 'Cette Nuit',
  },
  {
    name: 'POS first-word acrostic FR (4 lines)',
    technique: 'first word of each line acrostic',
    text: lines(
      'Rendez-moi la lumière des jours anciens,',
      'Vous qui gardez les clés de ma mémoire ;',
      'Demain peut-être, au détour des chemins,',
      'Soir après soir, je reprendrai l’histoire.',
    ),
    expected: 'Rendez Vous Demain Soir',
  },
  {
    name: 'POS first-word acrostic EN (4 lines)',
    technique: 'first word of each line acrostic',
    text: lines(
      'Meet the morning with a quiet heart,',
      'Me and my shadow walking side by side,',
      'At every corner something new to start,',
      'Midnight is far and the road is wide.',
    ),
    expected: 'Meet Me At Midnight',
  },
  {
    name: 'POS zero-width binary in prose',
    technique: 'zero-width stego (U+200B=0, U+200C=1, 8 bits)',
    get text() {
      return `Thanks for the lovely dinner yesterday.${zeroWidthBits('meet at noon')} See you soon!`;
    },
    expected: 'meet at noon',
  },
  {
    name: 'POS Caesar +3 sentence',
    technique: 'Caesar',
    text: 'Wkh phhwlqj lv dw wkh rog ploo diwhu gdun.',
    expected: 'The meeting is at the old mill after dark',
  },
  {
    name: 'POS Base64 FR sentence',
    technique: 'base64',
    text: 'Q2V0dGUgbnVpdCBhdSBwb250IGR1IGNoYXRlYXU=',
    expected: 'Cette nuit au pont du chateau',
  },
  {
    name: 'POS first-letter acrostic EN SENDHELP (8 lines)',
    technique: 'first letter of each line acrostic',
    text: lines(
      'Silver rain falls gently on the town,',
      'Every window glows with yellow light,',
      'Nobody hurries as the sun goes down,',
      'Dusk is folding softly into night.',
      'Heavy clouds are drifting from the bay,',
      'Echoes of the harbour bells remain,',
      'Lanterns flicker at the end of day,',
      'Patient hearts are waiting for the train.',
    ),
    expected: 'send help',
  },
  {
    name: 'POS first-letter acrostic EN HELLOWORLD (10 lines)',
    technique: 'first letter of each line acrostic',
    text: lines(
      'Holding the lantern high above the door,',
      'Every guest stepped in out of the cold,',
      'Laughing at the snow upon the floor,',
      'Leaving boots beside the chest of gold.',
      'Old friends gathered round the kitchen fire,',
      'Waiting for the kettle and the bread,',
      'Over bread they talked of rain and wire,',
      'Railway news and all the things they read.',
      'Long into the night the stories flowed,',
      'Dreaming of the summer on the road.',
    ),
    expected: 'hello world',
  },
  {
    name: 'POS first-letter acrostic FR MIDI (4 lines)',
    technique: 'first letter of each line acrostic',
    text: lines(
      "Mes pas s'en vont le long du vieux chemin,",
      'Il fait si doux que le temps semble suspendu,',
      'Dans le jardin fleurissent les lilas,',
      'Ici je rêve et j’attends le soleil.',
    ),
    expected: 'midi',
    weak: true,
  },
];

const SAND_LINES = [
  'Cette grande faveur que votre ardeur réclame',
  'Nuit peut-être à l’honneur mais répond à ma flamme.',
];
const MUSSET_LINES = [
  'Quand je mets à vos pieds un éternel hommage',
  'Voulez-vous qu’un instant je change de visage',
  'Vous avez capturé les sentiments d’un cœur',
  'Que pour vous adorer forma le Créateur',
  'Je vous chéris, amour, et ma plume en délire',
  'Couche sur le papier ce que je n’ose dire',
  'Avec soin de mes vers lisez les premiers mots',
  'Vous saurez quel remède apporter à mes maux',
];
const MUSSET_ANSWER = 'Quand Voulez Vous Que Je Couche Avec Vous';

/** Hard-wrap prose at `width` columns, the way an e-mail client or a text editor does. */
export function wrapText(text: string, width: number): string {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) {
      out.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out.join('\n');
}

const PROSE_EN =
  'The old lighthouse keeper climbed the spiral stairs every evening, long before the first ships appeared on the horizon. He carried a lantern, a loaf of bread and a battered notebook in which he wrote down the weather, the tides and anything strange that the sea had brought to the rocks that day. Most nights there was nothing to report, and he would close the book with a quiet sigh and watch the great lamp turn.';
const PROSE_FR =
  'Le marché ouvre tous les samedis matin sur la place de la mairie. On y trouve des légumes de saison, du fromage et du pain frais, et les habitants viennent souvent en famille. Les enfants courent autour de la fontaine pendant que les parents discutent avec les marchands, et tout le monde reste jusqu’à midi avant de rentrer déjeuner.';

/** Paste variants of the reference cases, and layouts that fooled earlier versions. */
export const VARIANT_CASES: TextCase[] = [
  {
    name: 'Sand, blank line between the verses',
    technique: 'first word of each line',
    text: `${SAND_LINES[0]}\n\n${SAND_LINES[1]}`,
    expected: 'Cette Nuit',
  },
  {
    name: 'Sand, first verse ends with "!"',
    technique: 'first word of each line',
    text: `${SAND_LINES[0]} !\n${SAND_LINES[1]}`,
    expected: 'Cette Nuit',
  },
  {
    name: 'Sand, lowercase verses',
    technique: 'first word of each line',
    text: SAND_LINES.map((l) => l.toLowerCase()).join('\n'),
    expected: 'Cette Nuit',
  },
  {
    name: 'Sand, CRLF line endings',
    technique: 'first word of each line',
    text: SAND_LINES.join('\r\n'),
    expected: 'Cette Nuit',
  },
  {
    name: 'Sand, numbered verses',
    technique: 'first word of each line',
    text: SAND_LINES.map((l, i) => `${i + 1}. ${l}`).join('\n'),
    expected: 'Cette Nuit',
  },
  {
    name: 'Sand, bulleted verses',
    technique: 'first word of each line',
    text: SAND_LINES.map((l) => `- ${l}`).join('\n'),
    expected: 'Cette Nuit',
  },
  {
    name: 'Sand, decomposed accents (NFD)',
    technique: 'first word of each line',
    text: SAND_LINES.join('\n').normalize('NFD'),
    expected: 'Cette Nuit',
  },
  {
    name: 'Musset, every verse ends with "."',
    technique: 'first word of each line',
    text: MUSSET_LINES.map((l) => `${l}.`).join('\n'),
    expected: MUSSET_ANSWER,
  },
  {
    name: 'Musset, lowercase verses',
    technique: 'first word of each line',
    text: MUSSET_LINES.map((l) => l.toLowerCase()).join('\n'),
    expected: MUSSET_ANSWER,
  },
  {
    name: 'Title-case lines',
    technique: 'ordinary text (negative)',
    text: lines(
      'The Quick Brown Fox',
      'Jumps Over The Lazy Dog',
      'And Runs Into The Woods',
      'To Find Its Way Home',
    ),
    negative: true,
  },
  {
    name: 'Shopping list, one item per line',
    technique: 'ordinary list (negative)',
    text: lines('Milk', 'Eggs', 'Bread', 'Butter', 'Apples', 'Cheese', 'Coffee', 'Rice'),
    negative: true,
  },
  ...[40, 50, 60, 70, 80].map((width): TextCase => ({
    name: `English prose wrapped at ${width}`,
    technique: 'ordinary text with hard line wraps (negative)',
    text: wrapText(PROSE_EN, width),
    negative: true,
  })),
  ...[40, 50, 60, 70, 80].map((width): TextCase => ({
    name: `French prose wrapped at ${width}`,
    technique: 'ordinary text with hard line wraps (negative)',
    text: wrapText(PROSE_FR, width),
    negative: true,
  })),
];

// ---------------------------------------------------------------------------------------------
// Round-2 cases from two independent blind verifications (recall and precision). Every text is
// original or public domain; names, addresses and numbers are invented. Payload texts are built
// on demand with the encoders of the matching tools.

/** UTF-8 bits of a string, high bit first. */
function bitsOf(secret: string): number[] {
  const bits: number[] = [];
  for (const byte of new TextEncoder().encode(secret)) {
    for (let b = 7; b >= 0; b--) bits.push((byte >> b) & 1);
  }
  return bits;
}

/** Cyrillic lookalikes of Latin letters, as homoglyph encoders swap them. */
const CYRILLIC: Record<string, string> = {
  a: 'а',
  c: 'с',
  e: 'е',
  i: 'і',
  j: 'ј',
  o: 'о',
  p: 'р',
  s: 'ѕ',
  x: 'х',
  y: 'у',
};

/**
 * One bit per carrier letter (a letter that has a lookalike): bit 1 swaps it for its Cyrillic
 * twin. `cut` ends the text right after the last carrier used.
 */
function homoglyphBits(cover: string, secret: string, carriers: string, cut = false): string {
  const bits = bitsOf(secret);
  let out = '';
  let used = 0;
  for (const ch of cover) {
    if (used < bits.length && carriers.includes(ch)) {
      out += bits[used] ? CYRILLIC[ch]! : ch;
      used++;
      if (cut && used === bits.length) break;
    } else out += ch;
  }
  return out;
}

/** One bit per carrier letter of a lowercase cover: bit 1 writes it as a capital. */
function caseBits(cover: string, secret: string, carrier: RegExp, cut = false): string {
  const bits = bitsOf(secret);
  let out = '';
  let used = 0;
  for (const ch of cover) {
    if (used < bits.length && carrier.test(ch)) {
      out += bits[used] ? ch.toUpperCase() : ch;
      used++;
      if (cut && used === bits.length) break;
    } else out += ch;
  }
  return out;
}

const CAFE_FR =
  'Le petit café de la place ouvre tôt le matin, bien avant que les commerçants ne lèvent leurs rideaux. Le patron prépare le comptoir, essuie les tasses et allume la vieille machine à expresso pendant que les premiers clients arrivent pour lire le journal. On y parle de la pluie, des élections et du match de la veille, et personne ne semble pressé de repartir travailler. Vers neuf heures, la salle se vide peu à peu et le calme revient jusqu’au déjeuner.';
const MOUNTAIN_FR =
  'nous avons passé une excellente semaine à la montagne avec les enfants. il a neigé presque tous les jours, alors nous avons fait de la luge, des bonshommes de neige et de longues promenades dans la forêt. le soir, nous mangions une fondue près de la cheminée avant de jouer aux cartes jusqu’à minuit. nous espérons revenir l’hiver prochain avec nos amis de lyon.';
const MOUNTAIN_EN =
  'we had a wonderful week in the mountains, it snowed every single day and the children spent hours building snowmen and sliding down the hill behind the chalet. in the evenings we played cards by the fire and went to bed early, tired and happy. we hope to go back next winter with our friends from the city.';

const LIGHTHOUSE_ARTICLE = [
  'Long before satellites and radio beacons, sailors approaching an unknown coast at night had little more than a compass, a chart of doubtful accuracy and the hope of a friendly light. A single fire on a headland could mean the difference between a safe harbour and a wreck on the rocks, and coastal towns learned early that a well kept light was worth its cost in wood, coal or oil.',
  'The first lights were simple bonfires lit on hills or on the roofs of towers. They burned huge quantities of fuel, smoked heavily and could be hidden by rain or fog just when they were needed most. Keepers had to carry wood up narrow stairs all night, and a careless moment could leave a stretch of coast in darkness for hours.',
  'Oil lamps brought a great improvement. A row of wicks placed in front of polished metal reflectors threw a beam far out to sea, and the flame could be trimmed and cleaned without climbing to the top of an open fire. Even so, the light spread in every direction, and most of it was wasted on the sky or on the land behind the tower.',
  'The real change came with the lens. Instead of one heavy curved glass, engineers built a frame of many rings of prisms that bent the light into a narrow, powerful beam. The design was lighter, cheaper to make and far brighter than anything before it. Within a few decades, towers along every busy coast had been fitted with these glittering beehives of glass, some taller than a man.',
  'A light alone was not enough, because a sailor had to know which light he was looking at. Each station was therefore given its own character: a fixed light, a flash every five seconds, two short flashes and a long eclipse, a red sector over dangerous shoals. Printed lists described every light on the coast, and a navigator who counted the seconds with a watch could tell where he was even on a moonless night.',
  'Life in a lighthouse was lonely and demanding. Keepers lived with their families on bare islands or at the end of long causeways, sometimes cut off for weeks by storms. They wound the clockwork that turned the lens, polished the brass, cleaned soot from the glass and wrote every change of weather in a logbook. Many stations kept two or three keepers so that someone was always awake during the night.',
  'Fog was the great enemy. When the light could no longer be seen, stations sounded bells, then horns driven by compressed air, each with its own pattern of blasts. On some days the horn sounded for hours without a break, and keepers learned to sleep through a noise that could be heard miles away across the water.',
  'In the twentieth century electricity replaced oil, and automatic lamp changers made it possible to run a light without anyone on the spot. One by one the keepers left, the cottages were closed and the stations were watched from a distance. Radio beacons and later satellite positioning made the lights less important for ships that could afford modern equipment.',
  'Yet the towers have not disappeared. Small boats and fishermen still rely on them, and many have become museums, holiday homes or simply landmarks that people travel to see. Standing at the foot of one on a windy evening, watching the beam sweep slowly over the waves, it is easy to understand why these buildings still hold such a place in the imagination of every coastal town.',
].join('\n\n');

export const ROUND2_CASES: TextCase[] = [
  // ----- Recall: acrostics and regular picks
  {
    name: 'first-letter-lines-en',
    technique: 'First letter of each line (EN)',
    text: lines(
      'Harbour lights are flickering in the rain,',
      'Invisible ships drift slowly past the pier,',
      'Dockers whistle softly as they leave,',
      'Every crate is counted twice tonight.',
      'The captain checks the ledger once again,',
      'His hands are shaking in the cold,',
      'Engines rumble somewhere down below,',
      'Kettles whistle in the harbour inn,',
      'Even the gulls have gone to sleep,',
      'Yesterday’s catch is waiting on the quay,',
      'Someone is watching from the lighthouse door.',
    ),
    expected: 'hide the keys',
  },
  {
    name: 'first-letter-lines-fr',
    technique: 'First letter of each line (FR)',
    text: lines(
      'Sur la rivière glisse une barque grise,',
      'On entend les rames frapper l’eau froide,',
      'Un pêcheur somnole au bord du quai,',
      'Son chien veille à l’ombre des saules,',
      'Les saules pleurent dans le vent du soir,',
      'Et le brouillard monte des berges,',
      'Personne ne passe sur le chemin,',
      'Où les volets restent clos depuis l’hiver,',
      'Nul ne sait ce que l’eau emporte,',
      'Tant que la Seine garde ses secrets.',
    ),
    expected: 'sous le pont',
  },
  {
    name: 'last-letter-lines-en',
    technique: 'Last letter of each line (EN)',
    text: lines(
      'We waited for hours beneath the autumn sun',
      'and heard across the valley a hollow echo.',
      'Nobody dared to cross the frozen river',
      'until the bells rang out into the night;',
      'we sheltered under the silver birch',
      'and a stranger came along with his dog,',
      'then settled down to rest upon the sofa,',
      'his lips were dry with dust and thirst,',
      'towards the window lit by a single flame.',
    ),
    expected: 'north gate',
  },
  {
    name: 'last-letter-lines-fr',
    technique: 'Last letter of each line (FR)',
    text: lines(
      'Dans la cuisine flottait un doux parfum',
      'et dehors, au loin, résonnait un cri.',
      'La vieille prenait toujours le même chemin',
      'pendant que le grand-père tisonnait le feu,',
      'sans jamais montrer le moindre souci.',
      'Les chiens dormaient au cœur de la nuit',
      'et le vieux chat attendait juste là,',
      'rêvant de neige et de caribou.',
      'Personne ne parlait, ni peu ni trop,',
      'la petite jouait un air au piano',
      'qui rappelait le bruit de la mer',
      'jusqu’au bout de la nuit.',
    ),
    expected: 'minuit au port',
  },
  {
    name: 'first-word-lines-en',
    technique: 'First word of each line (EN)',
    text: lines(
      'Meet the morning with an open hand,',
      'Me they called the keeper of the bridge,',
      'Under a sky of iron and of smoke.',
      'The trains were late, the platform cold and grey,',
      'Station lamps were flickering one by one,',
      'Clock hands frozen at a quarter past nine.',
    ),
    expected: 'meet me under the station clock',
  },
  {
    name: 'first-word-lines-fr',
    technique: 'First word of each line (FR)',
    text: lines(
      'Demain, peut-être, le ciel sera plus clair,',
      'Soir après soir je guette ton retour,',
      'Derrière la fenêtre embuée du salon,',
      'La lampe veille encore sur la table,',
      'Gare à celui qui oublie ses promesses.',
    ),
    expected: 'demain soir derriere la gare',
  },
  {
    name: 'last-word-lines-en',
    technique: 'Last word of each line (EN)',
    text: lines(
      'The moon above the harbour hung pale and silver',
      'I searched my pockets twice but never found my keys',
      'The bakery on the corner was still open',
      'and the wind kept slamming all the doors',
    ),
    expected: 'silver keys open doors',
    // Content words in a row (no function word between them) read like a list of nouns to the
    // word-class model: ranked first, not provable as a message.
    weak: true,
  },
  {
    name: 'last-word-lines-fr',
    technique: 'Last word of each line (FR)',
    text: lines(
      'Dans la vieille maison régnait le silence,',
      'Le désordre du grenier était total ;',
      'Nous rangerons les cartons demain,',
      'Bien avant le lever du matin.',
    ),
    expected: 'silence total demain matin',
    // Content words in a row (no function word between them) read like a list of nouns to the
    // word-class model: ranked first, not provable as a message.
    weak: true,
  },
  {
    name: 'second-letter-lines-en',
    technique: '2nd character of each line (EN)',
    text: lines(
      'Stay close to the wall when you enter,',
      'Free your mind of every other thought,',
      'Many have tried and many have failed,',
      'Spring the latch with the tip of a knife,',
      'Adam left the lantern on the stairs,',
      'Look for the loose board near the stove,',
      'Do not make a sound when it creaks,',
      'Bring the rope and wait for my signal.',
    ),
    expected: 'trapdoor',
  },
  {
    name: 'third-letter-lines-fr',
    technique: '3rd character of each line (FR)',
    text: lines(
      'Calme et silencieuse, la forêt s’endort,',
      'Quand la lune se lève sur les collines,',
      'Rapide, un renard traverse le sentier,',
      'Froid comme la pierre, le vent descend,',
      'Parfois un hibou lance son appel,',
      'Cette nuit personne ne dormira,',
      'Rien ne bouge dans la vallée.',
    ),
    expected: 'la porte',
  },
  {
    name: 'every-3rd-letter-en',
    technique: 'Every 3rd letter of a paragraph (EN)',
    text: 'Duty, who fee scope? Ugly blog are random out, oh trap.',
    expected: 'the cellar door',
  },
  {
    name: 'every-5th-letter-fr',
    technique: 'Every 5th letter of a paragraph (FR)',
    text: 'Chauffer russe type présent, zut ! Riche, viens : ses allions sait entre.',
    expected: 'fuyez ce soir',
  },
  {
    name: 'null-cipher-first-letter-word-en',
    technique: 'First letter of each word (null cipher, EN)',
    text: 'Some eagles never die; hawks eat little pigeons.',
    expected: 'send help',
  },
  {
    name: 'first-letter-sentences-fr',
    technique: 'First letter of each sentence (FR)',
    text: 'Vous trouverez la clé sous le paillasson. Attendez que la voisine soit partie. Allumez la lumière du couloir. Un chat dort sur le canapé, ne le réveillez pas. Nourrissez les poissons rouges. Ouvrez la fenêtre de la chambre. Remplissez l’arrosoir pour les plantes. Dites bonjour au facteur si vous le croisez.',
    expected: 'va au nord',
  },
  {
    name: 'extra-paragraph-acrostic-en',
    technique: 'First letter of each paragraph (EN)',
    text: [
      'Good morning everyone. The quarterly numbers are in,\nand they look better than we feared.',
      'Operations reported fewer incidents than last quarter,\nand the new on-call rota seems to be working. Thanks to\neveryone who volunteered for the weekend shifts.',
      'Nobody has complained about the new coffee machine yet,\nwhich is a small miracle. Please keep the kitchen tidy.',
      'Our next offsite is planned for the second week of June.\nDetails will follow once the venue confirms.',
      'Remember to submit your expense reports before Friday.\nLate reports will roll over to next month.',
      'There will be cake in the meeting room at four to celebrate\nMaria’s ten years with the company. Do come along.',
      'Have a great weekend, all of you.',
    ].join('\n\n'),
    expected: 'go north',
  },
  {
    name: 'variant-every-5th-ascii',
    technique: 'Every 5th letter FR, accent removed (rules out accent handling)',
    text: 'Chauffer russe type present, zut ! Riche, viens : ses allions sait entre.',
    expected: 'fuyez ce soir',
  },
  {
    name: 'variant-5th-fuyez-ascii2',
    technique: 'Every 5th letter FR, "fuyez", another ASCII cover',
    text: 'Chauffer juste type chef seize rencontre suisse canon veuillez riche.',
    expected: 'fuyez ce soir',
  },
  {
    name: 'variant-5th-partez-ascii',
    technique: 'Every 5th letter FR, "partez" instead of "fuyez" (control)',
    text: 'Sculpter laine, prenne tigre eaux y zone science, finissez loisir iront rit.',
    expected: 'partez ce soir',
  },
  {
    name: 'variant-5th-partez-accents',
    technique: 'Every 5th letter FR, accented cover words (control)',
    text: 'Champion payait règle titre eaux y zut récit bref aussi aidons qui maître.',
    expected: 'partez ce soir',
  },
  {
    name: 'variant-last-word-punctuated',
    technique: 'Last word of each line, every line ends with a period',
    text: lines(
      'The moon above the harbour hung pale and silver.',
      'I searched my pockets twice but never found my keys.',
      'The bakery on the corner was still open.',
      'And the wind kept slamming all the doors.',
    ),
    expected: 'silver keys open doors',
    // Content words in a row (no function word between them) read like a list of nouns to the
    // word-class model: ranked first, not provable as a message.
    weak: true,
  },
  {
    name: 'pos-en-acrostic-first-letters',
    technique: 'First letter of each line (10-line acrostic) = MEET AT DAWN',
    text: lines(
      'Morning fog was rolling over the hills',
      'Every bird had gone quiet in the trees',
      'Even the river seemed to slow its pace',
      'Tired horses waited by the empty barn',
      'A farmer crossed the yard without a word',
      'The kettle in the kitchen started singing',
      'Down the lane a cart was creaking slowly',
      'All the windows of the village were dark',
      'While the church bell rang the hour of six',
      'Nobody knew the soldiers were so close',
    ),
    expected: 'meet at dawn',
  },
  {
    name: 'pos-en-first-letter-of-words',
    technique: 'First letter of each word = RUN NOW (short null cipher)',
    text: 'Rapidly, unseen, nine nervous owls wandered.',
    expected: 'run now',
  },
  {
    name: 'pos-en-first-letter-words-long',
    technique: 'First letter of each word = ATTACK AT NOON (one word is a proper noun: Kevin)',
    text: 'All those tired actors called Kevin at ten, needing other options now.',
    expected: 'attack at noon',
  },
  {
    name: 'diag-attack-lower-kevin',
    technique: 'Same with "kevin" lowercased (control for the capital-letter segmentation)',
    text: 'All those tired actors called kevin at ten, needing other options now.',
    expected: 'attack at noon',
  },

  // ----- Recall: structured reading
  {
    name: 'odd-lines-en',
    technique: 'Every other line: odd lines (EN)',
    text: lines(
      'the drop is',
      'not what I expected when I moved here, but honestly',
      'under the bridge',
      'there is a little café where I read every morning',
      'at nine',
      'o’clock, before work. Write soon, love, Sam.',
    ),
    expected: 'the drop is under the bridge at nine',
  },
  {
    name: 'even-lines-fr',
    technique: 'Every other line: even lines (FR)',
    text: lines(
      'Chère maman, ici tout va bien, nous avons reçu',
      'le colis',
      'de tante Jeanne mardi. Le chat de la voisine',
      'est caché',
      'depuis trois jours, sans doute',
      'sous l’escalier',
      'de la cave. Je t’embrasse, Lucie.',
    ),
    expected: 'le colis est caché sous l’escalier',
  },
  {
    name: 'reverse-lines-fr',
    technique: 'Lines in reverse order (FR)',
    text: lines(
      'de la vieille ferme',
      'sans laisser de traces',
      'avant minuit',
      'tout brûler',
      'il faut',
    ),
    expected: 'il faut tout brûler avant minuit',
  },
  {
    name: 'diagonal-en',
    technique: 'Diagonal (character i of line i, EN)',
    text: lines(
      'Gather the wood before the storm arrives',
      'Not every road leads home',
      'Bowls of soup sat cold on the table',
      'Three crows sat on the fence',
      'Grass grew tall along the old road',
      'Almost nobody remembered the mill',
      'Abandoned farms dotted the valley',
      'By the oak tree a fox was sleeping',
      'Then we walked home without a word',
    ),
    expected: 'go west now',
  },
  {
    name: 'column-7-fr',
    technique: 'A column (7th character of every line, FR)',
    text: lines(
      'Je pense à toi chaque matin',
      'Dans son cœur brûlait un feu',
      'Il a vu une ombre passer',
      'Les roses fanent en silence',
      'Puis elle est partie sans un mot',
      'On a perdu la trace du chat',
      'La porte grinçait dans le noir',
      'Mon chat dort près du poêle',
      'Un temps gris couvrait la ville',
      'Le petit garçon pleurait',
      'Tu es seul face à la mer',
    ),
    expected: 'sous le tapis',
  },
  {
    name: 'variant-odd-lines-junk-filler',
    technique: 'Odd lines with junk even lines (control)',
    text: lines(
      'the drop is',
      'qzv kptr wnx bglh',
      'under the bridge',
      'xkcq vrtz plmn hjw',
      'at nine',
      'zzkr wqpt',
    ),
    expected: 'the drop is under the bridge at nine',
  },
  {
    name: 'variant-reverse-one-word-per-line',
    technique: 'Reverse lines, one word per line (forward reading is word salad)',
    text: lines(
      'ferme',
      'vieille',
      'la',
      'de',
      'traces',
      'de',
      'laisser',
      'sans',
      'minuit',
      'avant',
      'brûler',
      'tout',
      'faut',
      'il',
    ),
    expected: 'il faut tout brûler avant minuit',
  },

  // ----- Recall: invisible marks
  {
    name: 'zero-width-binary-en',
    technique: 'Zero-width chars U+200B/U+200C binary (EN)',
    get text() {
      return embedPayload(
        'Thanks for the update! I’ll review the pull request tomorrow morning and get back to you with comments.',
        encodePayload('flag{1nv1s1bl3_1nk}', 'binary').units,
        'spread',
      );
    },
    expected: 'flag{1nv1s1bl3_1nk}',
  },
  {
    name: 'zero-width-330k-fr',
    technique: 'Zero-width chars 330k scheme (FR)',
    get text() {
      return embedPayload(
        'Bonjour à tous, la réunion de jeudi est reportée à la semaine prochaine. Merci de confirmer votre présence.',
        encodePayload('la clé est dans le tiroir', '330k').units,
        'after-first',
      );
    },
    expected: 'la clé est dans le tiroir',
  },
  {
    name: 'snow-fr',
    technique: 'Trailing whitespace stegsnow (FR)',
    get text() {
      return encodeSnow(
        lines(
          'Le marché ouvre à sept heures,',
          'les pêcheurs déchargent leurs caisses,',
          'les mouettes tournent au-dessus du quai',
          'et le café fume déjà sur le comptoir.',
          'On parle du vent, de la marée,',
          'du prix du poisson et de la pluie.',
          'Un enfant court après un chien,',
          'une vieille dame compte sa monnaie,',
          'le boulanger crie le prix du pain.',
          'Vers midi, tout le monde rentre,',
          'les étals se vident peu à peu,',
          'et le port retrouve son calme.',
          'Seules les vagues continuent',
          'de frapper doucement la jetée.',
        ),
        'rendez-vous au phare',
      );
    },
    expected: 'rendez-vous au phare',
  },
  {
    name: 'trailing-binary-en',
    technique: 'Trailing spaces/tabs as bits, 1 byte per line (EN)',
    get text() {
      const events = [
        'Server logs rotated at midnight',
        'Backup job completed without errors',
        'Disk usage checked on all volumes',
        'Certificate renewal scheduled',
        'Mail queue flushed',
        'Cache cleared on the web nodes',
        'Database vacuum finished',
        'Monitoring agent restarted',
        'Firewall rules reloaded',
        'Time synchronised with the pool',
        'Old reports archived',
        'Temporary files removed',
        'Security updates downloaded',
        'Load balancer health check passed',
        'Weekly summary sent to the team',
        'Maintenance window closed',
      ];
      return encodeBinary(
        events.map((e, i) => `${e} (entry ${i + 1})`).join('\n'),
        'meet at pier 9',
      );
    },
    expected: 'meet at pier 9',
  },
  {
    name: 'homoglyph-bits-fr',
    technique: 'Homoglyphs: Cyrillic а/е/о/р/с = 1 bit (FR)',
    get text() {
      return homoglyphBits(CAFE_FR, 'va au nord', 'aeopc');
    },
    expected: 'va au nord',
  },
  {
    name: 'variant-homoglyph-broad-set',
    technique: 'Homoglyph bits, carriers a c e i j o p s x y',
    get text() {
      return homoglyphBits(CAFE_FR, 'va au nord', 'aceijopsxy');
    },
    expected: 'va au nord',
  },
  {
    name: 'variant-homoglyph-exact',
    technique: 'Homoglyph bits a/e/o/p/c, cover cut right after the 80th carrier',
    get text() {
      return homoglyphBits(CAFE_FR, 'va au nord', 'aeopc', true);
    },
    expected: 'va au nord',
  },
  {
    name: 'abnormal-caps-en',
    technique: 'Abnormal capitals spelling a word (EN)',
    text: 'The weather station on the riDge recorded strong winds last night. Our engineers will inspEct the bAsement and the roaD once the snow melts. Until then, please aDjust the heating, keep the geneRatOr running and stay away from the oPen shaft.',
    expected: 'dead drop',
  },
  {
    name: 'case-bits-fr',
    technique: 'Letter case as bits, capital = 1 (FR), ASCII letters carry the bits',
    get text() {
      return caseBits(MOUNTAIN_FR, 'flag{caps}', /[a-z]/);
    },
    expected: 'flag{caps}',
  },
  {
    name: 'variant-case-bits-ascii',
    technique: 'Case bits, ASCII cover with lowercase text after the payload',
    get text() {
      return caseBits(MOUNTAIN_EN, 'flag{caps}', /[a-z]/);
    },
    expected: 'flag{caps}',
  },
  {
    name: 'variant-case-bits-accents-as-carriers',
    technique: 'Case bits FR, accented letters carry bits too',
    get text() {
      return caseBits(MOUNTAIN_FR, 'flag{caps}', /\p{Ll}/u);
    },
    expected: 'flag{caps}',
  },
  {
    name: 'variant-case-bits-exact',
    technique: 'Case bits, cover cut right after the 80th letter (control)',
    get text() {
      return caseBits(MOUNTAIN_EN, 'flag{caps}', /[a-z]/, true);
    },
    expected: 'flag{caps}',
  },
  {
    name: 'zero-width-tags-en',
    technique: 'Unicode tag characters U+E0000 (EN)',
    get text() {
      return embedPayload(
        'Reminder: the quarterly report is due next Monday, please send your figures by Friday.',
        encodePayload('flag{t4gs_4r3_s1l3nt}', 'tags').units,
        'end',
      );
    },
    expected: 'flag{t4gs_4r3_s1l3nt}',
  },
  {
    name: 'variation-selectors-en',
    technique: 'Variation selectors after an emoji (EN)',
    get text() {
      return embedPayload(
        '🎉 Great job team, see you all at the release party!',
        encodePayload('deploy on friday', 'variation').units,
        'after-first',
      );
    },
    expected: 'deploy on friday',
  },
  {
    name: 'bacon-case-en',
    technique: 'Bacon cipher carried by letter case (EN, capital = B)',
    get text() {
      const bits = baconEncodeBits('HIDENOW', '26');
      let i = 0;
      return 'the old lighthouse keeper wrote in his diary every night before he climbed the stairs to light the lamp, and he never missed a single evening in forty years.'.replace(
        /[a-z]/g,
        (c) => (i < bits.length && bits[i++] === '1' ? c.toUpperCase() : c),
      );
    },
    expected: 'hide now',
  },

  // ----- Recall: encodings
  {
    name: 'base64-in-prose-fr',
    technique: 'Base64 blob inside prose (FR)',
    text: 'Bonjour Marc, le colis contient la note suivante : ZmxhZ3tjb2xpc19waWVnZX0= merci de la transmettre au service informatique avant vendredi.',
    expected: 'flag{colis_piege}',
  },
  {
    name: 'hex-in-prose-en',
    technique: 'Hex blob inside prose (EN)',
    text: 'The firmware dump at offset 0x200 shows the string 6d65657420617420746865206f6c64206d696c6c right before the checksum block.',
    expected: 'meet at the old mill',
  },
  {
    name: 'binary-in-prose-fr',
    technique: 'Binary blob inside prose (FR)',
    text: 'Sur le mur du bunker, quelqu’un a gravé 01101100 01100001 00100000 01110000 01101111 01110010 01110100 01100101 00100000 01100010 01101100 01100101 01110101 01100101 puis plus rien.',
    expected: 'la porte bleue',
  },
  {
    name: 'morse-in-prose-en',
    technique: 'Morse blob inside prose (EN)',
    text: 'The radio crackled at three in the morning: -.-. .... . -.-. -.- / - .... . / ... .- ..-. . and then there was only static.',
    expected: 'check the safe',
  },
  {
    name: 'variant-morse-alone',
    technique: 'Morse, whole text',
    text: '-.-. .... . -.-. -.- / - .... . / ... .- ..-. .',
    expected: 'check the safe',
  },
  {
    name: 'pos-fr-morse',
    technique: 'Morse code of a French sentence after a French preamble',
    text: 'Message intercepté hier soir :\n.-.. .- / -.-. .-.. . / . ... - / ... --- ..- ... / .-.. . / .--. .- .. .-.. .-.. .- ... ... --- -.',
    expected: 'la cle est sous le paillasson',
  },
  {
    name: 'pos-en-morse-bare',
    technique: 'Morse only, English sentence',
    text: '-- . . - / -- . / .- - / - .... . / --- .-.. -.. / -... .-. .. -.. --. . / .- - / -. --- --- -.',
    expected: 'meet me at the old bridge at noon',
  },
  {
    name: 'leet-in-prose-en',
    technique: 'Leet speak inside prose (EN)',
    text: 'Before leaving, he scribbled on the napkin: 7h3 p455w0rd 15 m0nk3y, then paid and walked out.',
    expected: 'the password is monkey',
  },
  {
    name: 'variant-leet-whole',
    technique: 'Leet, whole text',
    text: '7h3 k3y 15 h1dd3n und3r 7h3 m47',
    expected: 'the key is hidden under the mat',
  },
  {
    name: 'nato-en',
    technique: 'NATO phonetic alphabet (EN)',
    text: 'Romeo Uniform November / Alfa Whiskey Alfa Yankee',
    expected: 'run away',
  },
  {
    name: 'multitap-en',
    technique: 'Phone keypad multi-tap (EN)',
    text: '7777 33 66 3 0 44 33 555 7',
    expected: 'send help',
  },
  {
    name: 'extra-decimal-in-prose-fr',
    technique: 'Decimal ASCII codes inside prose (FR)',
    text: 'Le badge affichait une suite étrange : 108 97 32 115 97 108 108 101 32 52 50 avant de s’éteindre.',
    expected: 'la salle 42',
  },
  {
    name: 'pos-fr-hex-in-log',
    technique: 'Hex-encoded French sentence inside a log line',
    text: '2026-10-12T09:00:01Z INFO session opened payload=6c65206d6f74206465207061737365206573742064616e73206c65207469726f6972 user=guest',
    expected: 'le mot de passe est dans le tiroir',
  },
  {
    name: 'extra-azerty-on-qwerty-fr',
    technique: 'AZERTY typed with a QWERTY layout (FR)',
    text: 'rendew-vous q lq gqre de lyon q ;idi',
    expected: 'rendez-vous a la gare de lyon',
  },

  // ----- Recall: classical ciphers
  {
    name: 'caesar-fr',
    technique: 'Caesar shift 11 (FR)',
    text: 'Cpyopk-gzfd opcctpcp wl gtptwwp prwtdp l xtyfte, gpypk dpfwd.',
    expected: 'rendez-vous derriere la vieille eglise',
  },
  {
    name: 'pos-fr-caesar-11',
    technique: 'Caesar +11 on a French sentence',
    text: 'wp cpyopk-gzfd pde qtip l wl rlcp of yzco opxlty l xtyfte',
    expected: 'le rendez-vous est fixe a la gare du nord demain a minuit',
  },
  {
    name: 'diag-fr-tapis-caesar',
    technique: 'Caesar +5 of "la cle est sous le tapis" (control for the paillasson cliff)',
    text: 'qf hqj jxy xtzx qj yfunx',
    expected: 'la cle est sous le tapis',
  },
  {
    name: 'diag-fr-paillasson-caesar',
    technique: 'Caesar +5 of "le paillasson est devant la porte" (one less-common word)',
    text: 'qj ufnqqfxxts jxy ijafsy qf utwyj',
    expected: 'le paillasson est devant la porte',
  },
  {
    name: 'diag-en-upper-caesar',
    technique: 'Caesar +5 of an uppercase English sentence',
    text: 'YMJ PJD NX ZSIJW YMJ ITTWRFY',
    expected: 'the key is under the doormat',
  },
  {
    name: 'atbash-en',
    technique: 'Atbash (EN)',
    text: 'Yfib gsv tlow yvmvzgs gsv low lzp givv mvzi gsv irevi.',
    expected: 'bury the gold beneath the old oak tree',
  },
  {
    name: 'pos-en-atbash',
    technique: 'Atbash of an English sentence',
    text: 'gsv kzxpztv rh dzrgrmt rm olxpvi mrmv zg gsv hgzgrlm',
    expected: 'the package is waiting in locker nine at the station',
  },
  {
    name: 'extra-rot13-en',
    technique: 'ROT13 (EN)',
    text: 'Gur pbhevre jnvgf ng gur abegu ragenapr bs gur zhfrhz.',
    expected: 'the courier waits at the north entrance',
  },
  {
    name: 'rot47-flag',
    technique: 'ROT47 (flag)',
    text: '7=28LC_Ecf0`d0?_E04CJAE_N',
    expected: 'flag{r0t47_15_n0t_crypt0}',
  },
  {
    name: 'vigenere-en',
    technique: 'Vigenère key LANTERN (EN, 177 letters)',
    text: 'Ehr llzcxeam azyw aekmmr lt gai ebctuxve jlrraslfp oa Yvzqly roievyg. Ztov ffrr mlv tfaeww rep dvlxinntrw eeq ehnm xyr nazxvrf zn gai vndt fbhv nce fpmkpseq hjw opfbki vypvrg. Xyr aaflafeo fbk xyr ragx mj ytgumlfhde.',
    expected: 'the shipment will arrive',
  },
  {
    name: 'vigenere-fr',
    technique: 'Vigenère key CORBEAU (FR, 150 letters)',
    text: 'Nsj escooseuw siph tbghyu rrow ly ecwgve xg zr cenkws tfrtlczv. Jp fuwh rhmr uxoeu pa zkb uv qocu, gzosn nqik tiru rsiey piwf epys yv dfvv niu odjw dy Nmfo uuc chkfrdyph uftucu zfoktyodj.',
    expected: 'les documents sont caches',
  },
  {
    name: 'substitution-en',
    technique: 'Monoalphabetic substitution (EN, 348 letters)',
    text: 'Ac tpr npci af cei isifafm teif cei dng uareikopf uafpnnw kicvkfig cd cei epkhdvk. Ei epg hiif pc rip udk cekii gpwr pfg ear hdpc tpr uvnn du ransik uare. Ear taui tpr tpacafm df cei xvpw tace p npfcikf pfg p tpko bdpc, pfg cei beangkif kpf gdtf cei rcdfi rciqr cd oiic eao. Fdhdgw prlig phdvc cei rcdko cepc epg liqc eao ptpw, pfg ei gag fdc rqipl du ac vfcan cei fiyc odkfafm, teif cei tedni sannpmi mpceikig pc cei opklic cd eipk cei rcdkw.',
    expected: 'it was late in the evening',
  },

  // ----- Precision: ordinary texts that must not raise a strong claim
  {
    name: 'negative-fr-news',
    technique: 'Negative: ordinary French paragraph',
    text: lines(
      'La mairie a annoncé hier la fermeture temporaire de la piscine municipale pour travaux.',
      'Les nageurs pourront se rendre au centre aquatique de la commune voisine,',
      'où des créneaux supplémentaires seront ouverts le mercredi et le samedi.',
      'La réouverture est prévue au début du mois de mars.',
    ),
    negative: true,
  },
  {
    name: 'negative-en-email',
    technique: 'Negative: ordinary English email',
    text: lines(
      'Hi Laura,',
      'Thanks for sending the slides over. I had a quick look and they seem fine to me.',
      'Could you add the sales figures for the third quarter before the meeting?',
      'See you on Thursday,',
      'Tom',
    ),
    negative: true,
  },
  {
    name: 'fr-prose-boulangerie',
    technique: 'French prose paragraph',
    text: 'Ce matin, la boulangerie du coin avait déjà fermé ses volets quand je suis passé vers huit heures. Une affiche annonçait des congés jusqu’à lundi prochain. J’ai donc marché jusqu’à la place du marché, où un petit stand vendait des croissants encore tièdes. Le vendeur m’a raconté que son four était tombé en panne la veille et qu’il avait cuit toute la nuit chez un collègue.',
    negative: true,
  },
  {
    name: 'en-prose-train',
    technique: 'English prose paragraph',
    text: 'The night train left the station twenty minutes late, which nobody seemed to mind. Most passengers were already asleep, wrapped in coats and scarves, while a few played cards in the dining car. Outside, the dark fields slid past under a thin moon, broken now and then by the lights of a sleeping village. By the time we reached the border, the conductor had served coffee to everyone still awake.',
    negative: true,
  },
  {
    name: 'fr-poem-rhyme-function-words',
    technique: 'French rhyming poem (no acrostic), lines start with Le/Et/Je/Dans/Sous/Mais/La/Et',
    text: lines(
      'Le soir descend sur les toits de la ville,',
      'Et la lumière glisse au bord des volets,',
      'Je regarde passer la foule tranquille,',
      'Dans les rues où l’on rentre à pas discrets.',
      'Sous les platanes dorment les pigeons gris,',
      'Mais un vieil accordéon chante encore,',
      'La lune monte au-dessus de Paris,',
      'Et la nuit tombe doucement sur le port.',
    ),
    negative: true,
  },
  {
    name: 'en-poem-rhyme-couplets',
    technique: 'English rhyming couplets (no acrostic)',
    text: lines(
      'The kettle sings upon the stove,',
      'And morning light spills through the grove;',
      'The cat is curled beside the door,',
      'The dog is sleeping on the floor.',
      'My mother hums a quiet tune,',
      'The garden waits for rain at noon;',
      'We gather bread and cups of tea,',
      'And sit as long as we are free.',
    ),
    negative: true,
  },
  {
    name: 'fr-song-chorus',
    technique: 'French song with repeated chorus',
    text: [
      lines(
        'Sur la route de Bordeaux',
        'On chantait sous la pluie',
        'Les valises dans le dos',
        'Et le cœur plein d’envies',
      ),
      lines(
        'La la la, la route est belle',
        'La la la, on ira loin',
        'La la la, sous les hirondelles',
        'On chantera jusqu’à demain',
      ),
      lines(
        'À Toulouse il faisait beau',
        'On dormait dans les prés',
        'On rêvait de bateaux',
        'Et de mers à traverser',
      ),
      lines(
        'La la la, la route est belle',
        'La la la, on ira loin',
        'La la la, sous les hirondelles',
        'On chantera jusqu’à demain',
      ),
    ].join('\n\n'),
    negative: true,
  },
  {
    name: 'en-song-chorus',
    technique: 'English song verses with oh-oh-oh chorus',
    text: lines(
      'Hey now, hey now, don’t you cry',
      'The summer’s leaving, say goodbye',
      'We’ll meet again when winter’s done',
      'And dance together in the sun',
      'Oh-oh-oh, oh-oh-oh',
      'Say goodbye, say goodbye',
      'Oh-oh-oh, oh-oh-oh',
      'The summer’s leaving, don’t you cry',
    ),
    negative: true,
  },
  {
    name: 'fr-shopping-list',
    technique: 'French shopping list with bullets',
    text: lines(
      'Liste de courses (samedi)',
      '- 2 baguettes',
      '- lait demi-écrémé x2',
      '- œufs (12)',
      '- beurre doux',
      '- jambon blanc, 4 tranches',
      '- tomates cerises',
      '- pommes golden 1 kg',
      '- café moulu',
      '- papier toilette',
    ),
    negative: true,
  },
  {
    name: 'en-shopping-list',
    technique: 'English shopping list, one item per line',
    text: lines(
      'Groceries',
      'milk',
      'eggs (dozen)',
      'bread',
      '3 avocados',
      'spinach',
      'chicken thighs',
      'rice 2kg',
      'olive oil',
      'dish soap',
      'bin bags',
    ),
    negative: true,
  },
  {
    name: 'ctf-description',
    technique: 'CTF challenge description with a flag-format placeholder CTF{...}',
    text: lines(
      'Challenge: Lost in the Archive (forensics, 300 pts)',
      'Our intern zipped the quarterly backups and then forgot the password.',
      'Somewhere inside the archive is the flag, in the usual format CTF{...}.',
      'Download archive.zip and recover it.',
      'Hint: the password is short and lowercase.',
      'Author: k3rnel_p4nic',
    ),
    negative: true,
  },
  {
    name: 'code-ts-debounce',
    technique: 'TypeScript code snippet',
    text: lines(
      'export function debounce<T extends (...args: unknown[]) => void>(fn: T, wait = 250) {',
      '  let handle: ReturnType<typeof setTimeout> | null = null;',
      '  return (...args: Parameters<T>): void => {',
      '    if (handle !== null) clearTimeout(handle);',
      '    handle = setTimeout(() => fn(...args), wait);',
      '  };',
      '}',
    ),
    negative: true,
  },
  {
    name: 'code-python-sha256',
    technique: 'Python snippet with a sha256 hex digest constant',
    text: lines(
      'import hashlib',
      '',
      'EXPECTED = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"',
      '',
      '',
      'def check(path: str) -> bool:',
      '    with open(path, "rb") as f:',
      '        digest = hashlib.sha256(f.read()).hexdigest()',
      '    return digest == EXPECTED',
      '',
      '',
      'if __name__ == "__main__":',
      '    print(check("data.bin"))',
    ),
    negative: true,
  },
  {
    name: 'nginx-log',
    technique: 'Web server log excerpt with hex request ids',
    text: lines(
      '203.0.113.42 - - [12/Oct/2026:08:14:03 +0000] "GET /api/v2/items?page=2&limit=50 HTTP/1.1" 200 5123 "-" "Mozilla/5.0 (X11; Linux x86_64)" req_id=4f9a2c71e0b3',
      '198.51.100.7 - - [12/Oct/2026:08:14:05 +0000] "POST /api/v2/login HTTP/1.1" 401 87 "https://example.org/login" "curl/8.4.0" req_id=a17c03d9e5f2',
      '203.0.113.42 - - [12/Oct/2026:08:14:09 +0000] "GET /static/app.3e7b1f.js HTTP/1.1" 304 0 "-" "Mozilla/5.0 (X11; Linux x86_64)" req_id=0b6e48d2c9a1',
      '192.0.2.15 - - [12/Oct/2026:08:14:12 +0000] "DELETE /api/v2/items/8812 HTTP/1.1" 204 0 "-" "python-requests/2.31" req_id=e2d5f7a6b041',
    ),
    negative: true,
  },
  {
    name: 'json-order',
    technique: 'JSON blob with ids, etag and md5',
    text: lines(
      '{',
      '  "id": "ord_8f2c41d9",',
      '  "created_at": "2026-09-30T17:42:11Z",',
      '  "status": "shipped",',
      '  "items": [',
      '    { "sku": "MUG-0042", "qty": 2, "price": 12.5 },',
      '    { "sku": "TEE-1180", "qty": 1, "price": 19.9 }',
      '  ],',
      '  "etag": "W/\\"5d41402abc4b2a76b9719d911017c592\\"",',
      '  "md5": "7d793037a0760186574b0282f2f435e7",',
      '  "total": 44.9',
      '}',
    ),
    negative: true,
  },
  {
    name: 'tweet-emoji-zwj',
    technique: 'Tweet with ZWJ family emoji, FE0F, skin tone, flag emoji, hashtags',
    text: 'Enfin les vacances !!! 🎉🌴☀️ Merci à toute l’équipe 👨‍👩‍👧‍👦❤️ on se retrouve en septembre 👋🏽 🇫🇷 #vacances #été #teamwork',
    negative: true,
  },
  {
    name: 'fr-minutes-names-numbers',
    technique: 'Meeting minutes with fictitious names, dates and amounts',
    text: lines(
      'Compte rendu de la réunion du 3 mars 2026.',
      'Présents : Claire Martin, Hugo Lefèvre, Nadia Benali, Paul Roux.',
      'Budget validé : 18 400 € (dont 2 750 € de formation).',
      'Décisions : recrutement d’un stagiaire en avril, migration du serveur le 14/04.',
      'Prochaine réunion : 7 avril, 9 h 30, salle B12.',
    ),
    negative: true,
  },
  {
    name: 'fr-one-line',
    technique: 'Very short: one French line',
    text: 'Bonjour à tous, la réunion est décalée à demain 10h.',
    negative: true,
  },
  { name: 'en-two-words', technique: 'Very short: two words', text: 'Hello world', negative: true },
  { name: 'fr-one-word', technique: 'Very short: one word', text: 'merci', negative: true },
  {
    name: 'en-long-article-5kb',
    technique: 'Long English article hard-wrapped at 72 columns',
    get text() {
      return LIGHTHOUSE_ARTICLE.split('\n\n')
        .map((p) => wrapText(p, 72))
        .join('\n\n');
    },
    negative: true,
  },
  {
    name: 'fr-article-typography',
    technique: 'French article with NBSP/NNBSP, « », —, …, curly apostrophes',
    text: [
      'Le marché du dimanche : une tradition qui résiste',
      'Chaque dimanche matin, la place de l’église se remplit d’étals colorés. « On vient ici depuis quarante ans ! » raconte Marcel, maraîcher à la retraite — il ne vend plus, mais il passe encore saluer tout le monde. Les prix ? Ils ont augmenté, bien sûr, mais les habitués restent fidèles ; certains font même vingt kilomètres pour acheter leurs fromages ici.',
      'À midi, les marchands replient leurs bâches… et la place retrouve son calme. « Tant qu’il y aura des clients, il y aura un marché », conclut Marcel avec un sourire. La mairie, elle, envisage d’agrandir l’espace l’an prochain : une bonne nouvelle pour les producteurs de la région.',
    ].join('\n\n'),
    negative: true,
  },
  {
    name: 'fr-conjugation-table',
    technique: 'Conjugation table: first words are all real pronouns (Je Tu Il Nous Vous Ils)',
    text: lines(
      'Je chante',
      'Tu chantes',
      'Il chante',
      'Nous chantons',
      'Vous chantez',
      'Ils chantent',
    ),
    negative: true,
  },
  {
    name: 'fr-gamer-leet-chat',
    technique: 'Visible leet in a chat message',
    text: 'gg wp tout le monde, ce n00b de l33t m’a 0wn3d au dernier round lol. on remet ça demain ?',
    negative: true,
  },
  {
    name: 'mixed-email-crlf',
    technique: 'FR/EN email with signature, CRLF line endings',
    text: [
      'Bonjour Paul,',
      '',
      'Thanks for the slides, they look great. Je te renvoie la version corrigée avant jeudi, with the new figures for Q3.',
      'On peut en parler à la réunion de lundi si tu veux.',
      '',
      'Bonne journée / Have a nice day,',
      '',
      '--',
      'Julie Moreau',
      'Responsable produit',
    ].join('\r\n'),
    negative: true,
  },
  {
    name: 'markdown-hard-breaks-tabs',
    technique: 'Markdown address with two trailing spaces (hard breaks) and tab-indented lines',
    text: lines(
      'Envoyez le colis à :  ',
      'Atelier des Tilleuls  ',
      '12 rue des Lilas  ',
      '00000 Villeneuve  ',
      '',
      '\tHoraires :',
      '\tlundi – vendredi, 9 h – 17 h',
      '\tfermé le week-end',
    ),
    negative: true,
  },
  {
    name: 'pd-hugo-demain-des-laube',
    technique: 'Public-domain rhyming French poem (Hugo), straight apostrophes',
    get text() {
      return TEXT_CASES.find((c) => c.name.startsWith('Hugo'))!.text.replace(/’/g, "'");
    },
    negative: true,
  },
  {
    name: 'pd-shakespeare-sonnet18',
    technique: 'Public-domain English sonnet (Shakespeare 18), straight apostrophes',
    get text() {
      return TEXT_CASES.find((c) => c.name.startsWith('Shakespeare'))!.text.replace(/’/g, "'");
    },
    negative: true,
  },
  {
    name: 'fr-couplet-et-je',
    technique: 'Two-line rhyming couplet whose first words form a common bigram (Et / Je)',
    text: lines(
      'Et le vent du soir glisse sur la plaine,',
      'Je sens mon vieux cœur qui bat à peine.',
    ),
    negative: true,
  },
  {
    name: 'bom-prefixed',
    technique: 'Text starting with a UTF-8 BOM (U+FEFF)',
    text: '﻿Bonjour, voici le fichier des inscriptions pour la sortie de dimanche. Merci de compléter avant vendredi soir.',
    negative: true,
  },
  {
    name: 'persian-zwnj',
    technique: 'Persian sentence with legitimate ZWNJ (U+200C) inside words',
    text: 'من می‌خواهم به خانه بروم و کتاب‌ها را بخوانم. آن‌ها فردا می‌آیند.',
    negative: true,
  },
  {
    name: 'hindi-zwj',
    technique: 'Hindi text with ZWJ conjunct control (U+200D)',
    text: 'नमस्ते, आज मौसम बहुत अच्छा है। क्‍ष और र‍य जैसे रूप भी लिखे जाते हैं।',
    negative: true,
  },
  {
    name: 'fr-brands-mixed-case',
    technique: 'Brand names with abnormal-looking case (iPhone, eBay, YouTube, LaTeX, PostgreSQL)',
    text: 'J’ai acheté un iPhone d’occasion sur eBay, regardé deux tutos sur YouTube, puis j’ai rédigé mon rapport en LaTeX avant de charger les données dans PostgreSQL et de tout envoyer sur GitHub.',
    negative: true,
  },
  {
    name: 'sql-query',
    technique: 'SQL query with uppercase keywords',
    text: lines(
      'SELECT u.id, u.email, COUNT(o.id) AS orders',
      'FROM users u',
      'LEFT JOIN orders o ON o.user_id = u.id',
      "WHERE u.created_at >= '2026-01-01'",
      'GROUP BY u.id, u.email',
      'HAVING COUNT(o.id) > 3',
      'ORDER BY orders DESC',
      'LIMIT 20;',
    ),
    negative: true,
  },
  {
    name: 'grades-decimal-range',
    technique: 'Numbers in the printable ASCII range (grades 65-90)',
    text: 'Résultats du contrôle : 72, 85, 79, 68, 90, 77, 83, 66, 74 et 88 sur 100.',
    negative: true,
  },
  {
    name: 'fr-caps-notice',
    technique: 'Notice with an all-caps sentence (Capital letters pass = visible text)',
    text: lines(
      'Bonjour à tous,',
      'ATTENTION : LA PISCINE SERA FERMÉE TOUTE LA SEMAINE POUR TRAVAUX.',
      'merci de votre compréhension.',
    ),
    negative: true,
  },
  {
    name: 'en-caps-warning',
    technique: 'Lowercase text with an all-caps warning sentence',
    text: 'please read carefully before entering. DO NOT LEAVE YOUR BAGS UNATTENDED IN THE LOBBY. thank you and enjoy your stay.',
    negative: true,
  },
  {
    name: 'en-shouting-chat',
    technique: 'Chat message mixing lowercase and an all-caps shout',
    text: 'omg did you see the match last night?? WE ARE GOING TO THE FINAL baby!!! cant wait',
    negative: true,
  },
  {
    name: 'fr-contract-caps-clause',
    technique: 'Contract with a capitalised legal clause',
    text: 'Le client reconnaît avoir pris connaissance des présentes conditions. LE PRESTATAIRE NE POURRA ÊTRE TENU RESPONSABLE DES DOMMAGES INDIRECTS. Tout litige relève du tribunal de commerce de Lyon.',
    negative: true,
  },
  {
    name: 'fr-all-caps-telegram',
    technique: 'Whole text in capitals',
    text: 'ARRIVONS GARE DE LYON MARDI 18H STOP PREVENIR TANTE MARIE STOP BAISERS',
    negative: true,
  },
  {
    name: 'mit-license',
    technique: 'MIT license text (all-caps warranty disclaimer)',
    text: [
      'MIT License',
      'Copyright (c) 2026 Example Contributors',
      'Permission is hereby granted, free of charge, to any person obtaining a copy of this software, to deal in the Software without restriction.',
      'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.',
    ].join('\n\n'),
    negative: true,
  },
  {
    name: 'fr-stacked-motto',
    technique: 'Motto stacked one word per line (first word of each line = input)',
    text: lines('Liberté', 'Égalité', 'Fraternité'),
    negative: true,
  },
  {
    name: 'en-stacked-poster',
    technique: 'Poster slogan stacked one word per line',
    text: lines('Keep', 'Calm', 'And', 'Carry', 'On'),
    negative: true,
  },
  {
    name: 'fr-sms-one-word-per-line',
    technique: 'Text message sent word by word (one word per line)',
    text: lines('je', 'suis', 'en', 'retard', 'désolé', 'j’arrive', 'dans', 'dix', 'minutes'),
    negative: true,
  },
  {
    name: 'bilingual-alternating-lines',
    technique: 'Lyrics with English translation on alternating lines',
    text: lines(
      'Il pleut sur la ville ce soir',
      'It is raining on the town tonight',
      'Et je marche seul sous les toits',
      'And I walk alone beneath the roofs',
      'Les lumières dansent dans le noir',
      'The lights are dancing in the dark',
      'Je pense à toi',
      'I think of you',
    ),
    negative: true,
  },
  {
    name: 'fr-double-spaced-paragraphs',
    technique: 'One-line paragraphs separated by blank lines',
    text: [
      'Le train est arrivé avec une heure de retard.',
      'Personne sur le quai ne semblait surpris.',
      'Les voyageurs ont pris leurs valises sans un mot.',
      'Dehors, il commençait à pleuvoir sur la gare.',
    ].join('\n\n'),
    negative: true,
  },
  {
    name: 'en-narrow-column-wrap',
    technique: 'Newspaper column hard-wrapped at 24 characters',
    text: wrapText(
      'The city council voted on Tuesday to extend the opening hours of the public library, which will now stay open until nine in the evening on weekdays and until six on Saturdays.',
      24,
    ),
    negative: true,
  },
  {
    name: 'lorem-ipsum',
    technique: 'Lorem ipsum filler (pseudo-Latin)',
    text: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.',
    negative: true,
  },
  {
    name: 'pl-tr-latin-letters',
    technique: 'Polish and Turkish words (ł, ś, ı, İ, ğ)',
    text: 'W środę idziemy na łąkę z psem. Yarın İstanbul’a gidiyoruz, ığdır değil, dağlara.',
    negative: true,
  },
  {
    name: 'fr-science-greek-symbols',
    technique: 'Physics note with µ, Ω, α, β, Δ',
    text: 'La résistance mesurée vaut 4,7 kΩ et l’épaisseur du film est de 12 µm. Le coefficient α = 0,05 et β = 1,2 ; on note ΔT = 15 K entre les deux faces de l’échantillon.',
    negative: true,
  },
  {
    name: 'truth-table-bits',
    technique: 'Logic truth table full of 0/1',
    text: lines(
      'A B | A AND B | A OR B | A XOR B',
      '0 0 |    0    |   0    |    0',
      '0 1 |    0    |   1    |    1',
      '1 0 |    0    |   1    |    1',
      '1 1 |    1    |   1    |    0',
    ),
    negative: true,
  },
  {
    name: 'camelcase-identifiers',
    technique: 'Code identifiers in CamelCase',
    text: lines(
      'const userProfileService = new UserProfileService(httpClientFactory, LoggerFactory.create());',
      'await userProfileService.loadUserPreferences(currentUserId, { forceRefresh: true });',
    ),
    negative: true,
  },
];

// ---------------------------------------------------------------------------------------------
// Stress cases: sizes, odd characters and regex traps. Inputs are built on demand.

export interface StressCase {
  name: string;
  technique: string;
  inputs: () => string[];
  /** 'error': must throw a ToolError; 'result': must analyse; 'either': one or the other, nothing else. */
  expect: 'error' | 'result' | 'either';
  /** Time budget per input on a quiet machine, in ms. */
  budgetMs?: number;
  /** Text that must appear among the top 3 results. */
  surfaces?: string;
}

const random = (seed: number, alphabet: string, n: number): string => {
  const rng = makeRng(seed);
  const chars = Array.from(alphabet);
  let out = '';
  for (let i = 0; i < n; i++) out += chars[Math.floor(rng() * chars.length)]!;
  return out;
};
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const prose = (n: number): string => {
  let out = '';
  while (out.length < n) out += `${PROSE_EN} ${PROSE_FR} `;
  return out.slice(0, n);
};
const wrapped = (n: number) => wrapText(prose(n), 72);
const shift3 = (s: string) =>
  s.replace(/[a-z]/gi, (c) => {
    const base = c <= 'Z' ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + 3) % 26) + base);
  });
const bytesOf = (s: string) => Array.from(new TextEncoder().encode(s));
const CJK = '天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜';
const distinctCjk = (n: number) => {
  let out = '';
  for (let i = 0; i < n; i++) out += String.fromCodePoint(0x4e00 + ((i * 7919) % 20000));
  return out;
};
const homoglyphProse = (n: number) =>
  prose(n).replace(/[aeo]/g, (c) => ({ a: 'а', e: 'е', o: 'о' })[c] ?? c);

export const STRESS_CASES: StressCase[] = [
  { name: 'Empty string', technique: 'edge-empty', inputs: () => [''], expect: 'error' },
  {
    name: 'Whitespace only',
    technique: 'edge-empty',
    inputs: () => [' \n\t \n  \r\n   '],
    expect: 'error',
  },
  {
    name: 'Whitespace only, 20 000 newlines',
    technique: 'edge-empty',
    inputs: () => ['\n'.repeat(20_000)],
    expect: 'error',
  },
  {
    name: 'One character (ASCII, accented, emoji)',
    technique: 'edge-small',
    inputs: () => ['a', 'é', '😀'],
    expect: 'either',
  },
  {
    name: 'Single 10 000-char line (prose, no newline)',
    technique: 'scale-line',
    inputs: () => [prose(10_000)],
    expect: 'result',
    budgetMs: 1000,
  },
  {
    name: 'Single 10 000-char line (letters only, no spaces)',
    technique: 'scale-line',
    inputs: () => ['abcdefghijklmnopqrstuvwxyz'.repeat(400).slice(0, 10_000)],
    expect: 'result',
    budgetMs: 1000,
  },
  {
    name: '5 000 short lines',
    technique: 'scale-lines',
    inputs: () => [Array.from({ length: 5000 }, (_, i) => `word word ${i % 10}`).join('\n')],
    expect: 'result',
    budgetMs: 2000,
  },
  {
    name: '5 000 one-char lines',
    technique: 'scale-lines',
    inputs: () => ['x\n'.repeat(5000)],
    expect: 'result',
    budgetMs: 2000,
  },
  {
    name: 'Prose 2 KB, first run in a fresh process (live budget 400 ms)',
    technique: 'budget-live',
    inputs: () => [wrapped(2048)],
    expect: 'result',
    budgetMs: 400,
  },
  {
    name: 'Prose 2 KB, warmed process (live budget 400 ms)',
    technique: 'budget-live',
    inputs: () => [wrapped(2048), wrapped(2048)],
    expect: 'result',
    budgetMs: 400,
  },
  {
    name: '2 KB ciphertext-like text (Caesar +3 of EN prose)',
    technique: 'budget-live',
    inputs: () => [
      shift3(wrapText(`${PROSE_EN} ${PROSE_EN} ${PROSE_EN} ${PROSE_EN} ${PROSE_EN}`, 72)).slice(
        0,
        2047,
      ),
    ],
    expect: 'result',
    budgetMs: 400,
  },
  {
    name: 'Prose 10 KB',
    technique: 'scale-prose',
    inputs: () => [wrapped(10_240)],
    expect: 'result',
    budgetMs: 1000,
  },
  {
    name: 'Prose 50 KB (budget 2 s)',
    technique: 'budget',
    inputs: () => [wrapped(51_200), prose(51_200)],
    expect: 'result',
    budgetMs: 2000,
  },
  {
    name: 'Prose 200 KB',
    technique: 'scale-prose',
    inputs: () => [wrapped(204_800), prose(204_800)],
    expect: 'result',
    budgetMs: 5000,
  },
  {
    name: 'CRLF line endings (Sand poem)',
    technique: 'line-endings',
    inputs: () => [SAND_LINES.join('\r\n')],
    expect: 'result',
    surfaces: 'Cette Nuit',
  },
  {
    name: 'Tabs',
    technique: 'whitespace',
    inputs: () => [
      wrapped(5000)
        .split('\n')
        .map((l, i) => '\t'.repeat(i % 3) + l)
        .join('\n'),
      prose(20_000).replace(/ /g, '\t'),
      'a\tb\tc\n'.repeat(2000),
    ],
    expect: 'result',
    budgetMs: 2000,
  },
  {
    name: 'Emoji and ZWJ sequences',
    technique: 'unicode',
    inputs: () => {
      const seqs = '👨\u200d👩\u200d👧\u200d👦 🏳\ufe0f\u200d🌈 👍🏽 🇫🇷 👩🏻\u200d💻 ';
      return [seqs.repeat(20), seqs.repeat(2400), '😀\n'.repeat(2000)];
    },
    expect: 'result',
    budgetMs: 2000,
  },
  {
    name: 'RTL Arabic / Hebrew / LRM-RLM marks',
    technique: 'unicode',
    inputs: () => [
      'مرحبا بكم في المدينة القديمة\n'.repeat(200),
      'שלום לכולם בעיר העתיקה\n'.repeat(200),
      'abc \u200fשלום\u200e def\n'.repeat(300),
    ],
    expect: 'result',
    budgetMs: 2000,
  },
  {
    name: 'Combining accents (NFD)',
    technique: 'unicode',
    inputs: () => [
      SAND_LINES.join('\n').normalize('NFD'),
      prose(50_000).normalize('NFD'),
      `a${'́'.repeat(2000)}`,
      'Z̶͒̕a̷͐l̴͡g̵o̸ '.repeat(500).slice(0, 10_000),
    ],
    expect: 'result',
    budgetMs: 2000,
  },
  {
    name: 'CJK small texts',
    technique: 'unicode',
    inputs: () => [
      `${CJK}\n`.repeat(300),
      'いろはにほへとちりぬるを\n'.repeat(300),
      Array.from({ length: 3000 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join('\n'),
    ],
    expect: 'result',
    budgetMs: 2000,
  },
  {
    name: 'CJK 20 000 distinct chars on one line',
    technique: 'unicode-scale',
    inputs: () => [distinctCjk(20_000)],
    expect: 'result',
    budgetMs: 2000,
  },
  {
    name: 'CJK paragraph 50 KB without spaces or newlines',
    technique: 'budget',
    inputs: () => [CJK.repeat(Math.ceil(50_000 / CJK.length)).slice(0, 50_000)],
    expect: 'result',
    budgetMs: 2000,
  },
  {
    name: 'Null bytes and control characters',
    technique: 'control-chars',
    inputs: () => {
      let c0 = '';
      for (let cp = 0; cp < 0x20; cp++) c0 += String.fromCharCode(cp);
      c0 += '\u007f';
      for (let cp = 0x80; cp < 0xa0; cp++) c0 += String.fromCharCode(cp);
      return [
        'abc\0def\0\nghi\0jkl'.repeat(100),
        '\0'.repeat(1000),
        c0.repeat(50),
        '\u001b[31mred\u001b[0m text\n'.repeat(500),
        '\ufffd'.repeat(3000),
        'lone \ud800 high and \udc00 low surrogates \ud83d',
        `\ufeff${SAND_LINES.join('\n')}`,
      ];
    },
    expect: 'either',
    budgetMs: 2000,
  },
  {
    name: 'Entirely invisible text (zero-width family)',
    technique: 'invisible',
    inputs: () => [
      random(1, '\u200b\u200c\u200d\ufeff', 5000),
      '\u200b\u200c'.repeat(25_000),
      random(2, '\u200b\u200c\u200d\u2060\u00ad\u00a0\u2003\u202e\u2066\u3164', 4500),
      random(3, '\u200b\u200c\n', 8000),
      Array.from(prose(20_000)).join('\u200b'),
    ],
    expect: 'either',
    budgetMs: 2000,
  },
  {
    name: 'Entirely invisible chars that String.trim() strips (tab/space only, NBSP/em-space only, BOM only)',
    technique: 'invisible',
    inputs: () => [random(4, ' \t', 200), random(5, '\u00a0\u2003', 100), '\ufeff'.repeat(50)],
    expect: 'result',
    budgetMs: 1000,
  },
  {
    name: 'SNOW-like trailing whitespace on 5 000 lines',
    technique: 'invisible',
    inputs: () => [
      Array.from({ length: 5000 }, (_, i) => `line ${i}${i % 2 ? ' \t ' : '\t '}`).join('\n'),
    ],
    expect: 'result',
    budgetMs: 2000,
  },
  {
    name: "Pathological repetition 'a' x 20 000",
    technique: 'pathological',
    inputs: () => ['a'.repeat(20_000), 'A'.repeat(20_000), '0'.repeat(20_000), 'ab'.repeat(10_000)],
    expect: 'result',
    budgetMs: 2000,
  },
  {
    name: "Pathological repetition 'a' x 100 000",
    technique: 'pathological',
    inputs: () => ['a'.repeat(100_000)],
    expect: 'result',
    budgetMs: 2000,
  },
  {
    name: "Pathological repetition 'a' x 200 000",
    technique: 'pathological',
    inputs: () => ['a'.repeat(200_000)],
    expect: 'result',
    budgetMs: 4000,
  },
  {
    name: 'Random base64, 30 KB',
    technique: 'pathological',
    inputs: () => {
      const one = `${random(6, B64, 30_720)}==`;
      const rng = makeRng(7);
      const bytes = Array.from({ length: 22_000 }, () => Math.floor(rng() * 256));
      let binary = '';
      for (const b of bytes) binary += String.fromCharCode(b);
      return [one, wrapText(one.replace(/(.{76})/g, '$1 '), 76), btoa(binary)];
    },
    expect: 'result',
    budgetMs: 2000,
  },
  {
    name: 'Random hex 50 KB, one line',
    technique: 'budget',
    inputs: () => [random(8, '0123456789abcdef', 51_200)],
    expect: 'result',
    budgetMs: 2000,
  },
  {
    name: 'Random letters 50 KB, one line',
    technique: 'budget',
    inputs: () => {
      const letters = random(9, 'abcdefghijklmnopqrstuvwxyz', 51_200);
      return [letters, letters.replace(/(.{5})/g, '$1 ')];
    },
    expect: 'result',
    budgetMs: 2000,
  },
  {
    name: 'Random base32 / base58 20 KB',
    technique: 'pathological',
    inputs: () => [
      random(10, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', 20_000),
      random(11, '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz', 20_000),
    ],
    expect: 'result',
    budgetMs: 2000,
  },
  {
    name: 'Random 0/1 20 000 chars and decimal byte list',
    technique: 'pathological',
    inputs: () => {
      const rng = makeRng(12);
      return [
        random(13, '01', 20_000),
        Array.from({ length: 6000 }, () => Math.floor(rng() * 256)).join(' '),
        random(14, '.-/ ', 20_000),
      ];
    },
    expect: 'result',
    budgetMs: 2000,
  },
  {
    name: 'Homoglyph flood',
    technique: 'output-bounds',
    inputs: () => [homoglyphProse(50_000), `x${'а'.repeat(20_000)}`],
    expect: 'result',
    budgetMs: 2000,
  },
  {
    name: 'Repeated and alternating patterns',
    technique: 'pathological',
    inputs: () => {
      const words = Array.from({ length: 100 }, (_, i) => `w${i.toString(36)}x`).join(' ');
      return [
        'abc def\n'.repeat(5000),
        'a\n'.repeat(10_000),
        prose(50_000).replace(/./g, (c, i: number) => (i % 2 ? c.toUpperCase() : c.toLowerCase())),
        `${words}\n`.repeat(2000),
      ];
    },
    expect: 'result',
    budgetMs: 2000,
  },
  {
    name: 'Fully valid binary (success path)',
    technique: 'pathological',
    inputs: () => {
      const rng = makeRng(15);
      return [
        Array.from({ length: 6000 }, () =>
          (32 + Math.floor(rng() * 95)).toString(2).padStart(8, '0'),
        ).join(' '),
      ];
    },
    expect: 'result',
    budgetMs: 2000,
  },
  {
    name: 'Catastrophic regex: space-separated bytes then one stray char',
    technique: 'redos',
    inputs: () =>
      [14, 24, 64].flatMap((n) => {
        const bytes = '01001000 '.repeat(n);
        return [`${bytes}.`, `${bytes} (end)`, `${bytes}\nand one line of text`];
      }),
    expect: 'result',
    budgetMs: 2000,
  },
  {
    name: 'Catastrophic regex: unbroken bit string then a stray char',
    technique: 'redos',
    inputs: () => [
      `${'01001000'.repeat(9)}.`,
      `${'01001000'.repeat(16)}.`,
      `${'01001000'.repeat(16)} ok`,
      `${'01001000'.repeat(16)}=`,
      `${'1'.repeat(80)}x`,
      `${'7'.repeat(80)}x`,
      `${'01'.repeat(36)}x`,
      `${'&amp;'.repeat(20_000)}x`,
      `${'%41'.repeat(20_000)}x`,
      `${'\\u0041'.repeat(4096)}x`,
    ],
    expect: 'result',
    budgetMs: 2000,
  },
  {
    name: 'Many encoded tokens inside prose',
    technique: 'scale-tokens',
    inputs: () => {
      const token = (seed: number, n: number) => random(seed, B64, n);
      const blobs = Array.from({ length: 14 }, (_, i) => `${prose(400)} ${token(20 + i, 7900)}`);
      const short = Array.from({ length: 2000 }, (_, i) => `word ${token(100 + i, 40)} and`);
      const hex = Array.from(
        { length: 2000 },
        (_, i) =>
          `x ${bytesOf(`tok${i}`)
            .map((b) => b.toString(16))
            .join('')}a1`,
      );
      return [blobs.join('\n'), short.join(' '), hex.join(' ')];
    },
    expect: 'result',
    budgetMs: 2500,
  },
  {
    name: 'Never throws anything but ToolError',
    technique: 'error-contract',
    inputs: () => [
      '\ud800',
      '\udfff\ud800',
      `${'\0'.repeat(500)}flag`,
      '%E0%A4%A'.repeat(50),
      '&#99999999;&#xFFFFFFFF;&#55296;',
      '\\u{110000}\\uD800\\x',
      '0b2 0b1 0b0',
      'U+110000 U+D800',
      '⠼⠼⠼⠼',
      '<~ ~>',
      '11 22 33 44 55 66 77 88',
      '-.-.-.-.-.-.-.-.-.-.-.-.-.-.-',
      wrapped(972_000),
    ],
    expect: 'either',
    budgetMs: 8000,
  },
  {
    name: 'Table row caps and output size',
    technique: 'output-bounds',
    inputs: () => [
      Array.from({ length: 5000 }, (_, i) => `l${i}`).join('\n'),
      distinctCjk(20_000),
      homoglyphProse(20_000),
      random(16, '01', 2000),
    ],
    expect: 'result',
    budgetMs: 2000,
  },
];
