/** Address formatting shared by the PCAP helpers. */

export function fmtIPv4(b: Uint8Array, o: number): string {
  return `${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`;
}

/** RFC 5952 text form: lowercase, longest run of zero groups collapsed to "::". */
export function fmtIPv6(b: Uint8Array, o: number): string {
  const g: number[] = [];
  for (let i = 0; i < 8; i++) g.push((b[o + i * 2]! << 8) | b[o + i * 2 + 1]!);
  let bestAt = -1;
  let bestLen = 1;
  for (let i = 0; i < 8;) {
    if (g[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && g[j] === 0) j++;
    if (j - i > bestLen) {
      bestAt = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = (xs: number[]) => xs.map((x) => x.toString(16)).join(':');
  if (bestAt < 0) return hex(g);
  return `${hex(g.slice(0, bestAt))}::${hex(g.slice(bestAt + bestLen))}`;
}

export function fmtMac(b: Uint8Array, o: number): string {
  let out = '';
  for (let i = 0; i < 6; i++) out += (i ? ':' : '') + b[o + i]!.toString(16).padStart(2, '0');
  return out;
}

/** Replace every non-printable ASCII byte of a latin1 string by "." (safe for tables). */
export function printable(s: string): string {
  return s.replace(/[^\x20-\x7e]/g, '.');
}

/** Glue byte arrays together. Unlike concatBytes(...parts) it has no limit on the part count. */
export function joinBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
