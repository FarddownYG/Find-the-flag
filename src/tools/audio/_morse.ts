/** International Morse code table, kept private to the audio tools. */

export const MORSE_TABLE: Readonly<Record<string, string>> = {
  A: '.-',
  B: '-...',
  C: '-.-.',
  D: '-..',
  E: '.',
  F: '..-.',
  G: '--.',
  H: '....',
  I: '..',
  J: '.---',
  K: '-.-',
  L: '.-..',
  M: '--',
  N: '-.',
  O: '---',
  P: '.--.',
  Q: '--.-',
  R: '.-.',
  S: '...',
  T: '-',
  U: '..-',
  V: '...-',
  W: '.--',
  X: '-..-',
  Y: '-.--',
  Z: '--..',
  '0': '-----',
  '1': '.----',
  '2': '..---',
  '3': '...--',
  '4': '....-',
  '5': '.....',
  '6': '-....',
  '7': '--...',
  '8': '---..',
  '9': '----.',
  '.': '.-.-.-',
  ',': '--..--',
  '?': '..--..',
  "'": '.----.',
  '!': '-.-.--',
  '/': '-..-.',
  '(': '-.--.',
  ')': '-.--.-',
  '&': '.-...',
  ':': '---...',
  ';': '-.-.-.',
  '=': '-...-',
  '+': '.-.-.',
  '-': '-....-',
  _: '..--.-',
  '"': '.-..-.',
  $: '...-..-',
  '@': '.--.-.',
};

const REVERSE = new Map(Object.entries(MORSE_TABLE).map(([ch, code]) => [code, ch]));

/** One letter's dots and dashes, or "?" when it is not a known code. */
export function morseChar(code: string): string {
  return REVERSE.get(code) ?? '?';
}

/**
 * Decode "... --- ... / .-" style text: letters separated by spaces, words by "/".
 * Unknown codes become "?".
 */
export function morseToText(symbols: string): string {
  return symbols
    .trim()
    .split(/\s*\/\s*/)
    .map((word) =>
      word
        .split(/\s+/)
        .filter(Boolean)
        .map((c) => morseChar(c))
        .join(''),
    )
    .join(' ');
}

/** Encode plain text (unknown characters are skipped). Words are separated by " / ". */
export function textToMorse(text: string): string {
  return text
    .toUpperCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) =>
      [...w]
        .map((c) => MORSE_TABLE[c])
        .filter((c): c is string => c !== undefined)
        .join(' '),
    )
    .join(' / ');
}
