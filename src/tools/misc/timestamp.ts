import { defineTool } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';

const NS_PER_S = 1_000_000_000n;
const MAX_DIGITS = 40;

interface Epoch {
  name: string;
  /** Nanoseconds in one tick of this format. */
  unitNs: bigint;
  /** Unix nanoseconds of tick 0 (negative when the epoch is before 1970). */
  offsetNs: bigint;
}

const EPOCHS: Epoch[] = [
  { name: 'Unix seconds', unitNs: NS_PER_S, offsetNs: 0n },
  { name: 'Unix milliseconds', unitNs: 1_000_000n, offsetNs: 0n },
  { name: 'Unix microseconds', unitNs: 1_000n, offsetNs: 0n },
  { name: 'Unix nanoseconds', unitNs: 1n, offsetNs: 0n },
  {
    name: 'Windows FILETIME (100 ns since 1601)',
    unitNs: 100n,
    offsetNs: -11_644_473_600n * NS_PER_S,
  },
  {
    name: '.NET ticks (100 ns since year 1)',
    unitNs: 100n,
    offsetNs: -62_135_596_800n * NS_PER_S,
  },
  {
    name: 'Chrome / WebKit (µs since 1601)',
    unitNs: 1_000n,
    offsetNs: -11_644_473_600n * NS_PER_S,
  },
  { name: 'Apple Cocoa (s since 2001)', unitNs: NS_PER_S, offsetNs: 978_307_200n * NS_PER_S },
  {
    name: 'HFS+ / classic Mac (s since 1904)',
    unitNs: NS_PER_S,
    offsetNs: -2_082_844_800n * NS_PER_S,
  },
  {
    name: 'Excel / OLE serial (days since 1899-12-30)',
    unitNs: 86_400n * NS_PER_S,
    offsetNs: -2_209_161_600n * NS_PER_S,
  },
];

const FAT_NAME = 'FAT / DOS date-time (local time)';

function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
}

/** ISO 8601 in UTC with milliseconds, or null when JavaScript cannot represent the date. */
function isoFromUnixNs(ns: bigint): { iso: string; year: number } | null {
  const ms = Number(floorDiv(ns, 1_000_000n));
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return null;
  const d = new Date(ms);
  return { iso: d.toISOString(), year: d.getUTCFullYear() };
}

const plausible = (year: number) => year >= 1990 && year <= 2040;

/** Exact decimal text of num/den with up to nine decimals and no trailing zeros. */
function ratio(num: bigint, den: bigint): string {
  const abs = num < 0n ? -num : num;
  const frac = ((abs % den) * 1_000_000_000n) / den;
  let text = (abs / den).toString();
  if (frac > 0n) text += `.${frac.toString().padStart(9, '0').replace(/0+$/, '')}`;
  return num < 0n && text !== '0' ? `-${text}` : text;
}

// ---------- numbers → dates ----------

interface Decimal {
  /** The digits with the point removed. */
  mantissa: bigint;
  /** How many digits were after the point. */
  scale: number;
}

function toUnixNs(d: Decimal, e: Epoch): bigint {
  return (d.mantissa * e.unitNs) / 10n ** BigInt(d.scale) + e.offsetNs;
}

function fatToIso(value: bigint): { iso: string; year: number } | null {
  if (value < 0n || value > 0xffffffffn) return null;
  const v = Number(value);
  const date = v >>> 16;
  const time = v & 0xffff;
  const year = 1980 + (date >>> 9);
  const month = (date >>> 5) & 15;
  const day = date & 31;
  const hour = time >>> 11;
  const minute = (time >>> 5) & 63;
  const second = (time & 31) * 2;
  const check = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    month < 1 ||
    month > 12 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    check.getUTCDate() !== day ||
    check.getUTCMonth() !== month - 1
  )
    return null;
  return { iso: check.toISOString(), year };
}

function interpretations(d: Decimal, title: string): Output[] {
  const rows: (string | number)[][] = [];
  const best: number[] = [];
  const add = (name: string, hit: { iso: string; year: number } | null) => {
    if (hit && plausible(hit.year)) best.push(rows.length);
    rows.push([name, hit?.iso ?? '-', hit && plausible(hit.year) ? 'yes' : '']);
  };
  for (const e of EPOCHS) add(e.name, isoFromUnixNs(toUnixNs(d, e)));
  add(FAT_NAME, d.scale === 0 ? fatToIso(d.mantissa) : null);
  const out: Output[] = [
    {
      type: 'table',
      label: title,
      columns: ['Interpretation', 'UTC', 'Plausible (1990-2040)'],
      rows,
      highlight: best,
    },
  ];
  if (best.length === 0) {
    out.push({
      type: 'note',
      level: 'info',
      text: 'No interpretation lands between 1990 and 2040, so this may not be a timestamp (or not in a format listed here).',
    });
  }
  return out;
}

// ---------- dates → numbers ----------

const ISO_RE =
  /^(\d{4})[-/](\d{2})[-/](\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?)?\s*(Z|UTC|GMT|[+-]\d{2}(?::?\d{2})?)?$/i;

function zoneSeconds(zone: string | undefined): number {
  if (!zone || /^(Z|UTC|GMT)$/i.test(zone)) return 0;
  const m = zone.match(/^([+-])(\d{2}):?(\d{2})?$/)!;
  const secs = Number(m[2]) * 3600 + Number(m[3] ?? 0) * 60;
  return m[1] === '-' ? -secs : secs;
}

/** Date text to Unix nanoseconds. A date without a zone is read as UTC, never as local time. */
function parseDate(raw: string): bigint {
  const s = raw.trim();
  const iso = s.match(ISO_RE);
  if (iso) {
    const [, y, mo, da, h = '0', mi = '0', se = '0', frac = '', zone] = iso;
    const d = new Date(0);
    d.setUTCFullYear(Number(y), Number(mo) - 1, Number(da));
    d.setUTCHours(Number(h), Number(mi), Number(se), 0);
    if (
      d.getUTCMonth() !== Number(mo) - 1 ||
      d.getUTCDate() !== Number(da) ||
      Number(h) > 23 ||
      Number(mi) > 59 ||
      Number(se) > 59
    ) {
      throw new ToolError(`"${s}" is not a real calendar date or time.`);
    }
    const sub = BigInt(frac.padEnd(9, '0') || '0');
    return (
      BigInt(Math.floor(d.getTime() / 1000)) * NS_PER_S + sub - BigInt(zoneSeconds(zone)) * NS_PER_S
    );
  }
  const hasZone = /(\b(Z|UTC|GMT)|[+-]\d{2}:?\d{2})\s*$/i.test(s);
  const ms = Date.parse(hasZone ? s : `${s} UTC`);
  if (Number.isNaN(ms)) {
    throw new ToolError(
      `Cannot read "${s}" as a number or a date. Try 2023-11-14T22:13:20Z, a Unix time such as 1700000000, or hex like 0x6553F100.`,
    );
  }
  return BigInt(ms) * 1_000_000n;
}

function datesToNumbers(ns: bigint): Output[] {
  const rows: (string | number)[][] = [];
  const hex = (v: bigint) => (v >= 0n ? `0x${v.toString(16)}` : '');
  for (const e of EPOCHS) {
    const shifted = ns - e.offsetNs;
    const value = ratio(shifted, e.unitNs);
    const whole = shifted % e.unitNs === 0n ? shifted / e.unitNs : null;
    rows.push([e.name, value, whole === null ? '' : hex(whole)]);
  }
  const filetime = (ns - EPOCHS[4]!.offsetNs) / 100n;
  if (filetime >= 0n && filetime < 1n << 64n) {
    const bytes = Array.from({ length: 8 }, (_, i) =>
      Number((filetime >> BigInt(8 * i)) & 0xffn)
        .toString(16)
        .padStart(2, '0'),
    );
    rows.push(['FILETIME as 8 bytes (little-endian)', bytes.join(' '), '']);
  }
  const d = new Date(Number(floorDiv(ns, 1_000_000n)));
  const year = d.getUTCFullYear();
  if (year >= 1980 && year <= 2107) {
    const date = ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
    const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
    const v = BigInt(date) * 65536n + BigInt(time);
    rows.push([`${FAT_NAME}, 2 s resolution`, v.toString(), hex(v)]);
  }
  const shown = isoFromUnixNs(ns);
  return [
    {
      type: 'table',
      label: `Numbers for ${shown?.iso ?? 'this instant'}`,
      columns: ['Format', 'Value', 'Hex'],
      rows,
    },
  ];
}

// ---------- input handling ----------

function decimalOf(text: string): Decimal | null {
  const m = text.match(/^([+-]?)(\d+)(?:\.(\d+))?$/);
  if (!m) return null;
  const frac = m[3] ?? '';
  const mantissa = BigInt(`${m[2]}${frac}`);
  return { mantissa: m[1] === '-' ? -mantissa : mantissa, scale: frac.length };
}

const hexNumber = (digits: string): Decimal => ({ mantissa: BigInt(`0x${digits}`), scale: 0 });

function reverseHexBytes(digits: string): string {
  return (digits.match(/../g) ?? []).reverse().join('');
}

function numberOutputs(raw: string): Output[] | null {
  const cleaned = raw.replace(/_/g, '');
  if (cleaned.length > MAX_DIGITS)
    throw new ToolError(`That number is longer than ${MAX_DIGITS} digits.`);

  const dec = decimalOf(cleaned);
  if (dec) return interpretations(dec, `Interpretations of ${cleaned}`);

  const prefixed = cleaned.match(/^0x([0-9a-f]+)$/i);
  if (prefixed) {
    const digits = prefixed[1]!.length % 2 ? `0${prefixed[1]!}` : prefixed[1]!;
    const out = interpretations(hexNumber(digits), `Interpretations of ${cleaned} as a number`);
    if (digits.length === 8 || digits.length === 16) {
      out.push(
        ...interpretations(
          hexNumber(reverseHexBytes(digits)),
          `Same bytes read little-endian (${reverseHexBytes(digits)})`,
        ),
      );
    }
    return out;
  }

  // Raw bytes as they appear in a hex dump: "00 80 3e d5 de b1 9d 01" or 0080 3ed5deb19d01 without spaces.
  const spaced = cleaned.match(/^[0-9a-f]{2}(?:[\s:,-]+[0-9a-f]{2}){3,7}$/i);
  const bare = /^(?:[0-9a-f]{8}|[0-9a-f]{16})$/i.test(cleaned) && /[a-f]/i.test(cleaned);
  if (spaced || bare) {
    const digits = cleaned.replace(/[^0-9a-f]/gi, '');
    if (digits.length === 8 || digits.length === 16) {
      return [
        ...interpretations(
          hexNumber(reverseHexBytes(digits)),
          `Bytes ${digits.match(/../g)!.join(' ')} read little-endian (Windows, x86)`,
        ),
        ...interpretations(hexNumber(digits), 'Same bytes read big-endian'),
      ];
    }
  }
  return null;
}

export default defineTool({
  id: 'timestamp',
  name: 'Timestamp converter',
  category: 'misc',
  description:
    'Turn a number into dates (Unix, FILETIME, Chrome, Cocoa, FAT...) or a date into every numeric form.',
  tags: [
    'epoch',
    'unix time',
    'filetime',
    'windows time',
    'chrome time',
    'webkit',
    'cocoa',
    'ticks',
    'date',
    'datetime',
    'dos time',
    'fat',
    'iso 8601',
    'strftime',
  ],
  input: 'text',
  placeholder: '1700000000   or   2023-11-14T22:13:20Z',
  examples: [
    { label: 'Unix seconds', input: '1700000000', expect: '2023-11-14T22:13:20.000Z' },
    { label: 'Unix milliseconds', input: '1700000000123', expect: '2023-11-14T22:13:20.123Z' },
    {
      label: 'FILETIME bytes from a hex dump',
      input: '00 80 3e d5 de b1 9d 01',
      expect: '1970-01-01T00:00:00.000Z',
    },
    {
      label: 'Chrome / WebKit time',
      input: '13344473600000000',
      expect: '2023-11-14T22:13:20.000Z',
    },
    { label: 'FAT / DOS time', input: '1466872234', expect: '2023-11-14T22:13:20.000Z' },
    { label: 'Date to numbers', input: '2023-11-14T22:13:20Z', expect: '133444736000000000' },
  ],
  detect({ text }) {
    const t = text?.trim();
    if (!t || t.length > 64) return null;
    if (/^1\d{9}$/.test(t)) return { score: 0.6, reason: 'Looks like Unix seconds' };
    if (/^1\d{12}$/.test(t)) return { score: 0.55, reason: 'Looks like Unix milliseconds' };
    if (/^13\d{16}$/.test(t)) return { score: 0.6, reason: 'Looks like a Windows FILETIME' };
    if (ISO_RE.test(t) && t.length >= 10) return { score: 0.7, reason: 'A date and time' };
    return null;
  },
  run(input) {
    const text = input.trim();
    if (!text) throw new ToolError('Enter a number (Unix time, FILETIME, hex...) or a date.');
    const fromNumber = numberOutputs(text);
    if (fromNumber) return fromNumber;
    return datesToNumbers(parseDate(text));
  },
});
