/**
 * Strings of an executable, region by region (section, overlay, bytes no section covers), so that
 * a string comes with the place it lives in. Reuses the scanner of the Strings tool.
 */
import { DEFAULT_FLAG_PATTERN } from '../../core/flags';
import { ToolError } from '../../core/errors';
import { toolT } from '../../i18n/tool-text';
import { Reader, hex, visible } from './_exe-bin';
import { findStrings } from './strings';

const T = toolT('exe-analyzer');

export interface StringRegion {
  name: string;
  offset: number;
  size: number;
  /** Also look for UTF-16 text (PE: wide strings are everywhere). */
  wide: boolean;
}

export interface StringRow {
  region: string;
  offset: number;
  encoding: string;
  text: string;
  flag: boolean;
}

export interface StringsResult {
  rows: StringRow[];
  /** Rows dropped by the output cap, and regions cut because they were too big. */
  droppedRows: number;
  cutRegions: string[];
}

const REGION_CAP = 8 << 20;
const TOTAL_CAP = 96 << 20;
const MAX_ROWS = 5000;

/** "text" matches ignoring case; "/regex/flags" is a regular expression. */
export function makeFilter(raw: string): ((s: string) => boolean) | null {
  const t = raw.trim();
  if (t === '') return null;
  const m = /^\/(.+)\/([dimsuv]*)$/s.exec(t);
  if (m) {
    let re: RegExp;
    try {
      re = new RegExp(m[1]!, m[2]);
    } catch (e) {
      throw new ToolError(T('error.badRegex', { filter: t, message: (e as Error).message }));
    }
    return (s) => re.test(s);
  }
  const needle = t.toLowerCase();
  return (s) => s.toLowerCase().includes(needle);
}

export async function collectStrings(
  r: Reader,
  regions: StringRegion[],
  min: number,
  test: ((s: string) => boolean) | null,
): Promise<StringsResult> {
  const flagRe = new RegExp(DEFAULT_FLAG_PATTERN);
  const all: StringRow[] = [];
  const cutRegions: string[] = [];
  let budget = TOTAL_CAP;
  for (const region of regions) {
    if (region.size <= 0 || budget <= 0) continue;
    const len = Math.min(region.size, REGION_CAP, budget);
    if (len < region.size) cutRegions.push(region.name);
    budget -= len;
    const bytes = await r.file.read(region.offset, len);
    const found = findStrings(bytes, min, region.wide ? ['ascii', 'utf16le'] : ['ascii']);
    for (const f of found) {
      if (test && !test(f.text)) continue;
      all.push({
        region: region.name,
        offset: region.offset + f.offset,
        encoding: f.encoding,
        text: visible(f.text, 400),
        flag: flagRe.test(f.text),
      });
    }
  }
  // Flag-like strings first, then file order.
  const flagged = all.filter((x) => x.flag);
  const rest = all.filter((x) => !x.flag);
  const ordered = [...flagged, ...rest];
  return {
    rows: ordered.slice(0, MAX_ROWS),
    droppedRows: Math.max(0, ordered.length - MAX_ROWS),
    cutRegions,
  };
}

export const hexOffset = (n: number): string => hex(n);
