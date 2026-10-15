/**
 * Original prose used as plaintext to make test ciphertexts for the cipher identifier (never
 * shipped as a tool). Five English passages and two French ones, all different in subject and
 * style, so that no threshold is tuned on one text.
 */

export const ENGLISH: readonly string[] = [
  'The challenge started on a quiet Friday evening when the organisers published a single text ' +
    'file and nothing else. There was no hint and no description, only a long block of letters ' +
    'that seemed to mean nothing at all. Some teams tried every encoding they knew, others looked ' +
    'for patterns in the length of the lines, and a few simply went to bed. By morning one player ' +
    'had noticed that the message never repeated a symbol twice in a row, which was strange for a ' +
    'text of that size, and that observation changed the whole direction of the search. Once the ' +
    'right method was found the plaintext appeared in seconds, and it turned out to be a short ' +
    'poem about patience.',
  'In the northern valleys the snow melts late, and the farmers wait until the river is loud ' +
    'again before they dare to plant anything. The children know the signs better than the ' +
    'adults: when the swallows come back to the barn, when the first yellow flowers open on the ' +
    'south slope, and when the old well begins to fill without anyone touching the pump. Every ' +
    'spring the village holds a small feast to celebrate the end of winter, with bread baked in ' +
    'the communal oven and a soup that nobody is allowed to make except the oldest woman in the ' +
    'street.',
  'A computer follows instructions exactly as they are written, which is both its greatest ' +
    'strength and its most frustrating weakness. When a program fails, the machine is never ' +
    'confused; it has simply done what it was told, and the mistake belongs to whoever wrote the ' +
    'instructions. Good programmers learn to read their own code as a stranger would, slowly and ' +
    'without trusting any assumption, and they test the smallest pieces first. It takes patience, ' +
    'but the reward is a system that behaves the same way tomorrow as it does today, and that is ' +
    'worth more than any clever shortcut.',
  'The train left the station twenty minutes late, but nobody on the platform seemed to mind. A ' +
    'man with a violin case sat down opposite a student who was already asleep, and the ' +
    'conductor walked slowly along the corridor checking tickets with the unhurried air of ' +
    'someone who has seen every possible excuse. Outside the window the fields turned from green ' +
    'to gold, and the distant hills lay under a thin layer of mist. By the time the first ' +
    'village appeared the violinist had opened his case, tuned a string, and begun to play ' +
    'something soft that made even the conductor stop and listen.',
  'Long before telescopes existed, careful observers noticed that a few bright points of light ' +
    'moved against the fixed pattern of the stars. They named these wanderers planets and wrote ' +
    'down their positions night after night for centuries, building tables that later ' +
    'astronomers used to discover the laws of motion. The work was slow and often tedious, yet ' +
    'it produced one of the most remarkable achievements in the history of science: a simple set ' +
    'of rules that predicts where each planet will appear years in advance, using nothing but ' +
    'arithmetic and a great deal of patience.',
];

export const FRENCH: readonly string[] = [
  'Le village se réveille doucement chaque matin, quand les premières lueurs du jour glissent ' +
    'sur les toits de tuiles rouges et que la boulangère allume son four. Les enfants traversent ' +
    "la place en courant, leur cartable sur le dos, tandis que les vieux messieurs s'installent " +
    'à la terrasse du café pour discuter de la pluie et du beau temps. Personne ne semble pressé, ' +
    "et pourtant tout le monde arrive toujours à l'heure. Il y a dans cette habitude tranquille " +
    'une sagesse que les habitants de la ville ont depuis longtemps oubliée, et que les visiteurs ' +
    "découvrent avec un étonnement mêlé d'envie.",
  'Pour résoudre une énigme de cryptographie, il faut d’abord observer le message sans chercher ' +
    'à le comprendre. On compte les lettres, on regarde si certains caractères reviennent plus ' +
    'souvent que d’autres, et on note les répétitions qui pourraient révéler la longueur d’une ' +
    'clé. Ensuite seulement on formule une hypothèse, que l’on teste avec patience et méthode. ' +
    'Les meilleurs joueurs ne se fient jamais à leur première intuition : ils vérifient chaque ' +
    'idée, même celles qui paraissent évidentes, car c’est souvent dans les détails négligés que ' +
    'se cache la solution du problème.',
];
