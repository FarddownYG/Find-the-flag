import { defineTool, select, toggle } from '../../core/define';
import { utf8Encode } from '../../lib/bytes';
import type { Output } from '../../core/types';

// HTML 4 Latin-1 names, in code point order from U+00A0 to U+00FF (96 names).
const LATIN1 = (
  'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn ' +
  'sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest ' +
  'Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute ' +
  'Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml ' +
  'Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc ' +
  'euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ' +
  'ugrave uacute ucirc uuml yacute thorn yuml'
).split(' ');

const GREEK_UPPER_A =
  'Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Nu Xi Omicron Pi Rho'.split(
    ' ',
  ); // U+0391..
const GREEK_UPPER_B = 'Sigma Tau Upsilon Phi Chi Psi Omega'.split(' '); // U+03A3..
const GREEK_LOWER =
  'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigmaf sigma tau upsilon phi chi psi omega'.split(
    ' ',
  ); // U+03B1..

// "name:code point" — the rest of HTML 4.01 (symbols, punctuation, arrows, maths).
const OTHERS = (
  'OElig:338 oelig:339 Scaron:352 scaron:353 Yuml:376 fnof:402 circ:710 tilde:732 thetasym:977 ' +
  'upsih:978 piv:982 ensp:8194 emsp:8195 thinsp:8201 zwnj:8204 zwj:8205 lrm:8206 rlm:8207 ' +
  'ndash:8211 mdash:8212 lsquo:8216 rsquo:8217 sbquo:8218 ldquo:8220 rdquo:8221 bdquo:8222 ' +
  'dagger:8224 Dagger:8225 bull:8226 hellip:8230 permil:8240 prime:8242 Prime:8243 lsaquo:8249 ' +
  'rsaquo:8250 oline:8254 frasl:8260 euro:8364 image:8465 weierp:8472 real:8476 trade:8482 ' +
  'alefsym:8501 larr:8592 uarr:8593 rarr:8594 darr:8595 harr:8596 crarr:8629 lArr:8656 uArr:8657 ' +
  'rArr:8658 dArr:8659 hArr:8660 forall:8704 part:8706 exist:8707 empty:8709 nabla:8711 isin:8712 ' +
  'notin:8713 ni:8715 prod:8719 sum:8721 minus:8722 lowast:8727 radic:8730 prop:8733 infin:8734 ' +
  'ang:8736 and:8743 or:8744 cap:8745 cup:8746 int:8747 there4:8756 sim:8764 cong:8773 asymp:8776 ' +
  'ne:8800 equiv:8801 le:8804 ge:8805 sub:8834 sup:8835 nsub:8836 sube:8838 supe:8839 oplus:8853 ' +
  'otimes:8855 perp:8869 sdot:8901 lceil:8968 rceil:8969 lfloor:8970 rfloor:8971 loz:9674 ' +
  'spades:9824 clubs:9827 hearts:9829 diams:9830 check:10003'
).split(' ');

// HTML5 names of ASCII punctuation, popular in filter-bypass payloads. Decoded, never produced.
const HTML5_ASCII: [string, number][] = [
  ['Tab', 9], ['NewLine', 10], ['excl', 33], ['num', 35], ['dollar', 36], ['percnt', 37],
  ['lpar', 40], ['rpar', 41], ['ast', 42], ['plus', 43], ['comma', 44], ['period', 46],
  ['sol', 47], ['colon', 58], ['semi', 59], ['equals', 61], ['quest', 63], ['commat', 64],
  ['lsqb', 91], ['lbrack', 91], ['bsol', 92], ['rsqb', 93], ['rbrack', 93], ['Hat', 94],
  ['lowbar', 95], ['grave', 96], ['lcub', 123], ['lbrace', 123], ['verbar', 124], ['vert', 124],
  ['rcub', 125], ['rbrace', 125],
]; // prettier-ignore

/** Names produced when encoding (HTML 4 set, one preferred name per code point). */
const NAME_TO_CODE = new Map<string, number>([
  ['amp', 38], ['lt', 60], ['gt', 62], ['quot', 34], ['apos', 39],
]); // prettier-ignore
LATIN1.forEach((n, i) => NAME_TO_CODE.set(n, 160 + i));
GREEK_UPPER_A.forEach((n, i) => NAME_TO_CODE.set(n, 913 + i));
GREEK_UPPER_B.forEach((n, i) => NAME_TO_CODE.set(n, 931 + i));
GREEK_LOWER.forEach((n, i) => NAME_TO_CODE.set(n, 945 + i));
for (const pair of OTHERS) {
  const [name, code] = pair.split(':');
  NAME_TO_CODE.set(name!, Number(code));
}

const CODE_TO_NAME = new Map<number, string>();
for (const [name, code] of NAME_TO_CODE) if (!CODE_TO_NAME.has(code)) CODE_TO_NAME.set(code, name);

/** Every name understood when decoding. */
export const HTML_ENTITY_NAMES: ReadonlyMap<string, number> = new Map([
  ...NAME_TO_CODE,
  ...HTML5_ASCII,
]);

const ENTITY = /&(?:#([0-9]+)|#[xX]([0-9a-fA-F]+)|([A-Za-z][A-Za-z0-9]*));?/g;
const MAX_CODE_POINT = 0x10ffff;

export interface HtmlDecoded {
  text: string;
  /** Number of entities replaced. */
  count: number;
  /** Entity-looking sequences that were not understood and left untouched. */
  unknown: string[];
}

/**
 * Decodes named (&amp;), decimal (&#38;) and hex (&#x26;) entities. The final semicolon is
 * optional for numeric entities and for known names (not before "=", so "?a=1&copy=2" survives
 * only when written with the semicolon). Unknown names and impossible numbers stay as written.
 */
export function htmlDecodeDetailed(input: string): HtmlDecoded {
  let count = 0;
  const unknown: string[] = [];
  const text = input.replace(
    ENTITY,
    (match, dec?: string, hex?: string, name?: string, offset?: number) => {
      let code: number | undefined;
      if (dec !== undefined) code = parseInt(dec, 10);
      else if (hex !== undefined) code = parseInt(hex, 16);
      else if (name !== undefined) {
        const known = HTML_ENTITY_NAMES.get(name);
        const semicolon = match.endsWith(';');
        const next = input[(offset ?? 0) + match.length];
        if (known !== undefined && (semicolon || next !== '=')) code = known;
      }
      if (code === undefined || code < 1 || code > MAX_CODE_POINT) {
        unknown.push(match);
        return match;
      }
      count++;
      return String.fromCodePoint(code);
    },
  );
  return { text, count, unknown };
}

export const htmlDecode = (input: string): string => htmlDecodeDetailed(input).text;

export type HtmlScope = 'special' | 'nonascii' | 'all';
export type HtmlFormat = 'named' | 'decimal' | 'hex';

/**
 * special: only & < > " ' — what makes text safe inside HTML;
 * nonascii: those plus every character above U+007F;
 * all: every character. `named` falls back to decimal when a character has no name.
 */
export function htmlEncode(
  text: string,
  scope: HtmlScope = 'nonascii',
  format: HtmlFormat = 'named',
): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    const special = code === 38 || code === 60 || code === 62 || code === 34 || code === 39;
    const wanted = scope === 'all' || special || (scope === 'nonascii' && code > 127);
    if (!wanted) {
      out += ch;
      continue;
    }
    const name = CODE_TO_NAME.get(code);
    if (format === 'named' && name) out += `&${name};`;
    else if (format === 'hex') out += `&#x${code.toString(16).toUpperCase()};`;
    else out += `&#${code};`;
  }
  return out;
}

export default defineTool({
  id: 'html-entities',
  name: 'HTML entities',
  category: 'encoding',
  description: 'Decode or encode &amp; &#38; &#x26; style entities (named, decimal and hex).',
  tags: [
    'html',
    'entity',
    'entities',
    'escape',
    'unescape',
    'xml',
    '&amp;',
    'ampersand',
    'From HTML Entity',
    'To HTML Entity',
  ],
  input: 'text',
  placeholder: '&#102;&#108;&#97;&#103;&lbrace;&hellip;&rbrace;   caf&eacute; &lt;b&gt;',
  options: {
    mode: toggle('Mode', ['decode', 'encode']),
    scope: select(
      'Encode',
      [
        { value: 'special', label: 'Only & < > " \'' },
        { value: 'nonascii', label: 'Those + non-ASCII characters' },
        { value: 'all', label: 'Every character' },
      ],
      'nonascii',
      { showIf: (v) => v.mode === 'encode' },
    ),
    format: toggle(
      'Style',
      [
        { value: 'named', label: 'Named &eacute;' },
        { value: 'decimal', label: 'Decimal &#233;' },
        { value: 'hex', label: 'Hex &#xE9;' },
      ],
      'named',
      { showIf: (v) => v.mode === 'encode' },
    ),
  },
  examples: [
    {
      label: 'Decimal entities',
      input: '&#102;&#108;&#97;&#103;&#123;html_entities&#125;',
      expect: 'flag{html_entities}',
    },
    {
      label: 'Hex entities',
      input: '&#x66;&#x6c;&#x61;&#x67;&#x7b;hex_entity&#x7d;',
      expect: 'flag{hex_entity}',
    },
    {
      label: 'Named entities',
      input: 'caf&eacute; &amp; cr&egrave;me &lt;br&gt; &copy; &euro;&hellip;',
      expect: 'café & crème <br> © €…',
    },
    {
      label: 'HTML5 punctuation names',
      input: 'flag&lbrace;html5&lowbar;names&rbrace;',
      expect: 'flag{html5_names}',
    },
    {
      label: 'Encode text',
      input: 'x < y & "z" é',
      options: { mode: 'encode' },
      expect: 'x &lt; y &amp; &quot;z&quot; &eacute;',
    },
  ],
  detect({ text }) {
    const t = text ?? '';
    if (!t.includes('&') || t.length > 500000) return null;
    const { count, text: decoded } = htmlDecodeDetailed(t);
    if (count === 0) return null;
    const mostly = decoded.length < t.length / 3;
    const score = mostly ? 0.92 : count >= 3 ? 0.85 : 0.6;
    return {
      score,
      options: { mode: 'decode' },
      reason: `${count} HTML entit${count === 1 ? 'y' : 'ies'}`,
    };
  },
  run(text, { mode, scope, format }) {
    if (mode === 'encode') return [{ type: 'text', value: htmlEncode(text, scope, format) }];
    const { text: value, count, unknown } = htmlDecodeDetailed(text);
    const out: Output[] = [{ type: 'text', value }];
    if (count === 0) {
      out.push({ type: 'note', level: 'info', text: 'No HTML entities found in the input.' });
    }
    if (unknown.length) {
      const shown = [...new Set(unknown)].slice(0, 8).join(' ');
      out.push({
        type: 'note',
        level: 'warn',
        text: `${unknown.length} sequence(s) look like entities but are unknown and were left as is: ${shown}`,
      });
    }
    return out;
  },
});

/** Decoded entities as UTF-8 bytes (for the Auto-decode tool). */
export const htmlDecodeBytes = (input: string): Uint8Array => utf8Encode(htmlDecode(input));
