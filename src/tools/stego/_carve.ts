import { parseGif } from './_gif';
import { parseJpeg } from './_jpeg';
import { parsePng } from './_png';

/** Exact end offset of the image file starting at byte 0, when its structure says so. */
export function imageFileEnd(bytes: Uint8Array, sigId: string): number | null {
  if (sigId === 'png') return parsePng(bytes)?.iendEnd ?? null;
  if (sigId === 'jpeg') return parseJpeg(bytes)?.end ?? null;
  if (sigId === 'gif') return parseGif(bytes)?.trailerEnd ?? null;
  return null;
}
