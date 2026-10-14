/**
 * Tiny QR encoder (byte mode, error correction L, versions 1-5, single block). It exists to
 * make test fixtures: the shipped tool only reads codes. Version 1 is 21x21 modules.
 */

const VERSIONS: Record<number, [number, number]> = {
  1: [19, 7],
  2: [34, 10],
  3: [55, 15],
  4: [80, 20],
  5: [108, 26],
};

/** GF(256) multiplication, polynomial 0x11D. */
function gfMul(a: number, b: number): number {
  let r = 0;
  for (let i = 7; i >= 0; i--) {
    r = (r << 1) ^ ((r >>> 7) * 0x11d);
    r ^= ((b >>> i) & 1) * a;
  }
  return r & 0xff;
}

function reedSolomon(data: number[], degree: number): number[] {
  const divisor = new Array<number>(degree).fill(0);
  divisor[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      divisor[j] = gfMul(divisor[j]!, root);
      if (j + 1 < degree) divisor[j]! ^= divisor[j + 1]!;
    }
    root = gfMul(root, 2);
  }
  const ecc = new Array<number>(degree).fill(0);
  for (const b of data) {
    const factor = b ^ ecc.shift()!;
    ecc.push(0);
    divisor.forEach((coef, i) => {
      ecc[i]! ^= gfMul(coef, factor);
    });
  }
  return ecc;
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** Modules of a QR code carrying `payload` (true = dark). */
export function qrEncode(payload: Uint8Array | string): boolean[][] {
  const bytes = typeof payload === 'string' ? [...new TextEncoder().encode(payload)] : [...payload];
  const version = [1, 2, 3, 4, 5].find((v) => 12 + 8 * bytes.length <= VERSIONS[v]![0] * 8);
  if (!version) throw new Error('payload too long for the tiny QR encoder (max 106 bytes)');
  const [dataCw, eccCw] = VERSIONS[version]!;
  const bits: number[] = [];
  const push = (value: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, 8);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, dataCw * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0xec; data.length < dataCw; pad ^= 0xec ^ 0x11) data.push(pad);
  const codewords = [...data, ...reedSolomon(data, eccCw)];

  const size = 17 + 4 * version;
  const modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const isFunction = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const setFn = (x: number, y: number, dark: boolean) => {
    modules[y]![x] = dark;
    isFunction[y]![x] = true;
  };
  for (let i = 0; i < size; i++) {
    setFn(6, i, i % 2 === 0);
    setFn(i, 6, i % 2 === 0);
  }
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) setFn(x, y, dist !== 2 && dist !== 4);
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  if (version >= 2) {
    const c = size - 7;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        setFn(c + dx, c + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }
  const drawFormat = (mask: number) => {
    const d = (1 << 3) | mask; // error correction L = 01
    let rem = d;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const fmt = ((d << 10) | rem) ^ 0x5412;
    const bit = (i: number) => ((fmt >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) setFn(8, i, bit(i));
    setFn(8, 7, bit(6));
    setFn(8, 8, bit(7));
    setFn(7, 8, bit(8));
    for (let i = 9; i < 15; i++) setFn(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, bit(i));
    setFn(8, size - 8, true);
  };
  drawFormat(0);
  let n = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
        if (!isFunction[y]![x] && n < codewords.length * 8) {
          modules[y]![x] = ((codewords[n >>> 3]! >>> (7 - (n & 7))) & 1) !== 0;
          n++;
        }
      }
    }
  }
  const applyMask = (m: number) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!isFunction[y]![x] && MASKS[m]!(x, y)) modules[y]![x] = !modules[y]![x];
      }
    }
  };
  const penalty = () => {
    let p = 0;
    const lines: boolean[][] = [];
    for (let k = 0; k < size; k++) {
      lines.push(modules[k]!);
      lines.push(modules.map((row) => row[k]!));
    }
    for (const line of lines) {
      let run = 1;
      for (let k = 1; k <= size; k++) {
        if (k < size && line[k] === line[k - 1]) run++;
        else {
          if (run >= 5) p += 3 + run - 5;
          run = 1;
        }
      }
      const s = line.map((b) => (b ? '1' : '0')).join('');
      for (const pat of ['10111010000', '00001011101']) {
        let at = s.indexOf(pat);
        while (at >= 0) {
          p += 40;
          at = s.indexOf(pat, at + 1);
        }
      }
    }
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = modules[y]![x];
        if (c === modules[y]![x + 1] && c === modules[y + 1]![x] && c === modules[y + 1]![x + 1]) {
          p += 3;
        }
      }
    }
    const dark = modules.flat().filter(Boolean).length;
    return p + (Math.ceil(Math.abs(dark * 20 - size * size * 10) / (size * size)) - 1) * 10;
  };
  let best = 0;
  let bestPenalty = Infinity;
  for (let m = 0; m < 8; m++) {
    applyMask(m);
    drawFormat(m);
    const pen = penalty();
    if (pen < bestPenalty) {
      bestPenalty = pen;
      best = m;
    }
    applyMask(m); // undo
  }
  applyMask(best);
  drawFormat(best);
  return modules;
}

/** Draw modules into an RGBA image: `scale` pixels per module and `quiet` modules of border. */
export function renderQr(
  modules: boolean[][],
  scale: number,
  quiet: number,
  colours: { dark: [number, number, number, number]; light: [number, number, number, number] } = {
    dark: [0, 0, 0, 255],
    light: [255, 255, 255, 255],
  },
): { width: number; height: number; data: Uint8ClampedArray } {
  const side = (modules.length + 2 * quiet) * scale;
  const data = new Uint8ClampedArray(side * side * 4);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const mx = Math.floor(x / scale) - quiet;
      const my = Math.floor(y / scale) - quiet;
      const dark = modules[my]?.[mx] === true;
      data.set(dark ? colours.dark : colours.light, (y * side + x) * 4);
    }
  }
  return { width: side, height: side, data };
}
