// Independent Bidi-override encoder, written from the public Unicode Bidirectional Algorithm
// (UAX #9) and the "Trojan Source" description: RLO (U+202E) forces the following run to be laid
// out right-to-left, LRO (U+202D) left-to-right, PDF (U+202C) pops the override. A string stored in
// logical order therefore DISPLAYS differently (reversed under RLO) while the bytes keep the
// logical order.
export const RLO = '‮';
export const LRO = '‭';
export const PDF = '‬';

// Wrap `secret` (logical order) in an RLO ... PDF run.
export function rloRun(secret: string, closed = true): string {
  return `${RLO}${secret}${closed ? PDF : ''}`;
}

// Wrap `secret` in an LRO ... PDF run.
export function lroRun(secret: string, closed = true): string {
  return `${LRO}${secret}${closed ? PDF : ''}`;
}

// What a renderer shows for a single RLO run of neutral/strong-LTR ASCII: the code points reversed.
export function visualRlo(secret: string): string {
  return [...secret].reverse().join('');
}

// Cover text with the secret embedded between `before` and `after`.
export function embed(before: string, secret: string, after: string, closed = true): string {
  return `${before}${rloRun(secret, closed)}${after}`;
}
