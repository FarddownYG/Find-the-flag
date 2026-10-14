/**
 * Perceptually uniform colormaps for the spectrogram. Inferno and magma are the matplotlib
 * maps (CC0), stored as 33 evenly spaced RGB stops and linearly interpolated to 256 entries.
 */

export type ColormapName = 'inferno' | 'magma' | 'gray' | 'gray-inv';

const INFERNO =
  '0000040403120b0724150b37210c4a2f0a5b3d09654a0c6b57106e64156e71196e7d1e6d8a226a972766a32c61b0315bbc3754c63d4dd04545da4e3ce35933eb6429f1711ff67e14f98c0afb9b06fcaa0ffbba1ff9c932f5d949f2e865f3f586fcffa4';
const MAGMA =
  '0000040303120a0822130d341d114729115a36106b440f7651127c5d177f6a1c81762181832681902a819c2e7faa337db73779c23b75cf4070db476ae55064ee5b5ef4695cf9785dfb8761fd9668fea571feb47bfec287fed194fde0a1fceeb0fcfdbf';

function fromStops(hex: string): Uint8Array {
  const stops = hex.length / 6;
  const rgb: number[] = [];
  for (let i = 0; i < stops; i++) {
    for (let c = 0; c < 3; c++) rgb.push(parseInt(hex.slice(i * 6 + c * 2, i * 6 + c * 2 + 2), 16));
  }
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const pos = (i / 255) * (stops - 1);
    const a = Math.min(stops - 2, Math.floor(pos));
    const f = pos - a;
    for (let c = 0; c < 3; c++) {
      lut[i * 3 + c] = Math.round(rgb[a * 3 + c]! * (1 - f) + rgb[(a + 1) * 3 + c]! * f);
    }
  }
  return lut;
}

function gray(inverted: boolean): Uint8Array {
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const v = inverted ? 255 - i : i;
    lut[i * 3] = lut[i * 3 + 1] = lut[i * 3 + 2] = v;
  }
  return lut;
}

/** 256 RGB triplets (768 bytes), index 0 = quietest, 255 = loudest. */
export function buildColormap(name: ColormapName): Uint8Array {
  if (name === 'inferno') return fromStops(INFERNO);
  if (name === 'magma') return fromStops(MAGMA);
  return gray(name === 'gray-inv');
}
