/**
 * Crib tools for the Enigma tool: where a known plaintext fragment (a "crib") can sit in a
 * ciphertext, and a brute-force search for the rotor order and start positions that turn the
 * ciphertext into that crib. Local analysis of the user's own ciphertext; nothing leaves the page.
 *
 * Two facts make it cheap:
 * - The machine is reciprocal and its stepping does not depend on the letters, so "decrypt the
 *   ciphertext window and compare with the crib" is the same as "encrypt the crib from the same
 *   rotor positions and look for the result in the ciphertext". That second form needs no
 *   knowledge of where the crib sits: every candidate state yields ONE string to look up.
 * - The state in front of the crib is searched, and the start of the message is recovered by
 *   stepping back (the double step makes that step non-unique, so there can be several).
 */
import {
  Enigma,
  plugTable,
  reflectorTable,
  rotorTables,
  type EnigmaSetup,
  type MachineId,
  type ReflectorId,
} from './_enigma';

const STATES = 26 * 26 * 26;

export interface CribPlacement {
  /** Index of the first ciphertext letter under the crib (0-based). */
  start: number;
  /** False when a ciphertext letter equals the crib letter above it. */
  possible: boolean;
  /** First crib index whose letter equals the ciphertext letter (-1 when possible). */
  clash: number;
}

/**
 * Every place the crib can be laid along the ciphertext. The Enigma never encrypts a letter to
 * itself (the reflector has no fixed point), so a place where a letter lines up with itself is
 * ruled out.
 */
export function cribPlacements(
  cipher: readonly number[],
  crib: readonly number[],
): CribPlacement[] {
  const out: CribPlacement[] = [];
  for (let start = 0; start + crib.length <= cipher.length; start++) {
    let clash = -1;
    for (let i = 0; i < crib.length; i++) {
      if (cipher[start + i] === crib[i]) {
        clash = i;
        break;
      }
    }
    out.push({ start, possible: clash < 0, clash });
  }
  return out;
}

export interface CribSearchInput {
  machine: MachineId;
  reflector: ReflectorId;
  /** One ring setting per wheel, the Greek wheel's first on the M4. */
  rings: readonly number[];
  /** The M4's Greek wheel: it never turns, so its rotor and position are taken as given. */
  greek: { rotor: string; start: number } | null;
  plugs: readonly (readonly [number, number])[];
  /** The rotors the three turning wheels may be (each used at most once). */
  pool: readonly string[];
  cipher: readonly number[];
  crib: readonly number[];
  /** Index of the crib in the message (0-based), or null to try every place it can sit. */
  position: number | null;
  /** Date.now() value after which the search stops and reports what it covered. */
  deadline: number;
  /** Stop once this many settings are found (a crib that short matches by chance). */
  maxHits?: number;
}

export interface CribHit {
  /** Rotors left, middle, right. */
  order: [string, string, string];
  /** Index in the message where the crib sits. */
  at: number;
  /** Rotor positions at the start of the message that lead there (several only after a double step). */
  starts: [number, number, number][];
}

export interface CribSearchResult {
  hits: CribHit[];
  /** Orders the search was asked to cover, and how many it finished. */
  orders: number;
  ordersDone: number;
  /** Places the crib was tried at. */
  placements: number;
  timedOut: boolean;
  /** The search stopped early because it found `maxHits` settings. */
  capped: boolean;
  /** Settings expected to match by pure chance over the part that was covered. */
  expectedChance: number;
}

function permutations(pool: readonly string[]): [string, string, string][] {
  const out: [string, string, string][] = [];
  for (const l of pool) {
    for (const m of pool) {
      if (m === l) continue;
      for (const r of pool) if (r !== l && r !== m) out.push([l, m, r]);
    }
  }
  return out;
}

/**
 * Message-start states (left, middle, right) that reach `state` after `count` key presses.
 * Empty when none does: the stepping cannot produce that state (it has holes around the
 * middle rotor's notch).
 */
export function stepBack(
  state: readonly [number, number, number],
  count: number,
  middleNotch: Uint8Array,
  rightNotch: Uint8Array,
): [number, number, number][] {
  // States are packed as (left * 26 + middle) * 26 + right; the set stays tiny (the stepping only
  // branches around the middle notch), so a plain array is enough for it.
  let cur = [(state[0] * 26 + state[1]) * 26 + state[2]];
  for (let j = 0; j < count; j++) {
    const next: number[] = [];
    for (const packed of cur) {
      const l = Math.floor(packed / 676);
      const m = Math.floor(packed / 26) % 26;
      const r0 = ((packed % 26) + 25) % 26;
      const add = (l0: number, m0: number) => {
        const key = (l0 * 26 + m0) * 26 + r0;
        if (!next.includes(key)) next.push(key);
      };
      const rightAtNotch = rightNotch[r0] === 1;
      // The middle rotor did not move.
      if (!rightAtNotch && middleNotch[m] !== 1) add(l, m);
      const m0 = (m + 25) % 26;
      // It was pushed by the right rotor's notch.
      if (rightAtNotch && middleNotch[m0] !== 1) add(l, m0);
      // It stood on its own notch and took the left rotor with it.
      if (middleNotch[m0] === 1) add((l + 25) % 26, m0);
    }
    if (!next.length) return [];
    cur = next;
  }
  return cur.map((k) => [Math.floor(k / 676), Math.floor(k / 26) % 26, k % 26]);
}

/** Search every rotor order of the pool and every start position for the crib. */
export function searchCrib(input: CribSearchInput): CribSearchResult {
  const { cipher, crib } = input;
  const m = crib.length;
  const maxHits = input.maxHits ?? 2000;

  const places: number[] = [];
  for (const p of cribPlacements(cipher, crib)) {
    if (p.possible && (input.position === null || p.start === input.position)) places.push(p.start);
  }
  const orders = permutations(input.pool);
  const result: CribSearchResult = {
    hits: [],
    orders: orders.length,
    ordersDone: 0,
    placements: places.length,
    timedOut: false,
    capped: false,
    expectedChance: 0,
  };
  if (!places.length || !m) {
    result.ordersDone = orders.length;
    return result;
  }

  // Letters through the plugboard on the way in; the way out uses the same table.
  const plug = plugTable(input.plugs);
  const cribIn = Uint8Array.from(crib, (c) => plug[c]!);

  // The reflector, with the Greek wheel (which never turns) folded in.
  const reflector = reflectorTable(input.reflector);
  let reflect = reflector;
  const ringTurning = input.rings.slice(input.rings.length - 3);
  if (input.greek) {
    const g = rotorTables(input.greek.rotor);
    const off = ((input.greek.start + 26 - input.rings[0]!) % 26) * 26;
    reflect = Uint8Array.from({ length: 26 }, (_, c) => g.bwd[off + reflector[g.fwd[off + c]!]!]!);
  }

  // What to look for: one place (compare letter by letter), or any of the possible places
  // (look the first letters up in a map, with a cheap filter on the first three).
  const single = places.length === 1;
  const k = Math.min(m, 11); // 26^11 stays an exact integer
  const byKey = new Map<number, number[]>();
  const prefix3 = new Uint8Array(STATES);
  if (!single) {
    for (const p of places) {
      let key = 0;
      for (let i = 0; i < k; i++) key = key * 26 + cipher[p + i]!;
      const list = byKey.get(key);
      if (list) list.push(p);
      else byKey.set(key, [p]);
      if (m >= 3) prefix3[(cipher[p]! * 26 + cipher[p + 1]!) * 26 + cipher[p + 2]!] = 1;
    }
  }
  const expected = single ? places[0]! : 0;

  const out = new Uint8Array(m);
  let tried = 0;
  for (const order of orders) {
    if (Date.now() > input.deadline) {
      result.timedOut = true;
      break;
    }
    const [tl, tm, tr] = order.map(rotorTables) as [
      ReturnType<typeof rotorTables>,
      ReturnType<typeof rotorTables>,
      ReturnType<typeof rotorTables>,
    ];
    const offOf = (ring: number) =>
      Uint16Array.from({ length: 26 }, (_, x) => ((x + 26 - ring) % 26) * 26);
    const offL = offOf(ringTurning[0]!);
    const offM = offOf(ringTurning[1]!);
    const offR = offOf(ringTurning[2]!);
    const fL = tl.fwd;
    const bL = tl.bwd;
    const fM = tm.fwd;
    const bM = tm.bwd;
    const fR = tr.fwd;
    const bR = tr.bwd;
    const nM = tm.notch;
    const nR = tr.notch;

    for (let s = 0; s < STATES; s++) {
      const l0 = (s / 676) | 0;
      const m0 = ((s / 26) | 0) % 26;
      const r0 = s % 26;
      let l = l0;
      let mid = m0;
      let r = r0;
      let key = 0;
      let candidates: number[] | undefined;
      let ok = true;
      for (let i = 0; i < m; i++) {
        if (nM[mid] === 1) {
          l = l === 25 ? 0 : l + 1;
          mid = mid === 25 ? 0 : mid + 1;
        } else if (nR[r] === 1) {
          mid = mid === 25 ? 0 : mid + 1;
        }
        r = r === 25 ? 0 : r + 1;
        let c = cribIn[i]!;
        c = fR[offR[r]! + c]!;
        c = fM[offM[mid]! + c]!;
        c = fL[offL[l]! + c]!;
        c = reflect[c]!;
        c = bL[offL[l]! + c]!;
        c = bM[offM[mid]! + c]!;
        c = bR[offR[r]! + c]!;
        c = plug[c]!;
        if (single) {
          if (c !== cipher[expected + i]) {
            ok = false;
            break;
          }
          continue;
        }
        out[i] = c;
        if (i < k) key = key * 26 + c;
        if (i === 2 && !prefix3[(out[0]! * 26 + out[1]!) * 26 + c]) {
          ok = false;
          break;
        }
        if (i === k - 1) {
          candidates = byKey.get(key);
          if (!candidates) {
            ok = false;
            break;
          }
        }
      }
      if (!ok) continue;
      const found = single
        ? [expected]
        : (candidates ?? []).filter((p) => matches(out, cipher, p, k, m));
      for (const at of found) {
        const starts = stepBack([l0, m0, r0], at, nM, nR);
        if (!starts.length) continue;
        result.hits.push({ order, at, starts });
        if (result.hits.length >= maxHits) {
          result.capped = true;
          break;
        }
      }
      if (result.capped) break;
    }
    if (result.capped) break;
    result.ordersDone++;
    tried++;
  }
  result.expectedChance = (tried * STATES * places.length) / 26 ** m;
  return result;
}

/** The letters after the first `from` of the window at `p` equal what was computed. */
function matches(
  out: Uint8Array,
  cipher: readonly number[],
  p: number,
  from: number,
  m: number,
): boolean {
  for (let i = from; i < m; i++) if (out[i] !== cipher[p + i]) return false;
  return true;
}

/** The settings of a hit as a full machine setup (so the whole message can be run through it). */
export function setupForHit(input: CribSearchInput, hit: CribHit, startIndex = 0): EnigmaSetup {
  const start = hit.starts[startIndex]!;
  return {
    machine: input.machine,
    rotors: input.greek ? [input.greek.rotor, ...hit.order] : hit.order,
    reflector: input.reflector,
    rings: input.rings,
    start: input.greek ? [input.greek.start, ...start] : start,
    plugs: input.plugs,
  };
}

/** Decrypt the whole message with a hit's settings (a fresh machine). */
export function decryptWithHit(input: CribSearchInput, hit: CribHit, startIndex = 0): number[] {
  const machine = new Enigma(setupForHit(input, hit, startIndex));
  return input.cipher.map((v) => machine.press(v));
}
