/**
 * Where does a reflected marker land in a page, and what got escaped around it?
 *
 * This is a deliberately small, heuristic HTML/JS scanner — enough to classify the injection
 * context of a reflection for a CTF, not a spec-compliant parser. The user pastes the response
 * source with a marker (e.g. `xMARKERx`) where their input came back, ideally followed by a probe
 * such as `'"<>` so the escaping of those characters can be read directly.
 */

export type XssContext =
  | 'html' // element content (text node)
  | 'attr-double' // inside a "double-quoted" attribute value
  | 'attr-single' // inside a 'single-quoted' attribute value
  | 'attr-unquoted' // inside an unquoted attribute value
  | 'tag' // inside a tag, between attributes (tag/attribute-name position)
  | 'event-handler' // inside an on* attribute (JavaScript in an attribute)
  | 'url' // inside a URL attribute value (href, src, action…)
  | 'js-string-single' // inside a '…' string in <script>
  | 'js-string-double' // inside a "…" string in <script>
  | 'js-string-template' // inside a `…` template string in <script>
  | 'js' // JavaScript code in <script>, not in a string
  | 'comment' // inside an <!-- HTML comment -->
  | 'css'; // inside <style> or a style="" attribute

export const SPECIAL = ['<', '>', '"', "'", '`'] as const;
export type Special = (typeof SPECIAL)[number];

export interface Escaping {
  /** Special characters that came back raw (usable to break out). */
  raw: Special[];
  /** Special characters that came back HTML-entity or backslash encoded (neutralised). */
  encoded: Special[];
}

export interface Occurrence {
  /** Byte offset of the marker in the input. */
  index: number;
  context: XssContext;
  /** The attribute or tag name involved, when the context is inside a tag. */
  attr?: string;
  /** A short slice of the input around the marker, for display. */
  snippet: string;
  escaping: Escaping;
}

const URL_ATTRS = new Set([
  'href',
  'src',
  'action',
  'formaction',
  'data',
  'poster',
  'xlink:href',
  'background',
  'cite',
  'longdesc',
  'srcset',
  'usemap',
]);

type TagState = 'between' | 'name' | 'preval' | 'unquoted' | 'quoted';

interface Scan {
  region: 'text' | 'comment' | 'script' | 'style' | 'tag';
  /** For 'tag': the quote currently open around a quoted value, '' otherwise. */
  quote: '"' | "'" | '';
  /** For 'tag': whether the cursor is in (or about to start) an attribute value. */
  inValue: boolean;
  /** For 'tag': the attribute whose value/name we are in. */
  attr: string;
  /** For 'tag': the tag name. */
  tag: string;
}

const isNameChar = (c: string) => /[A-Za-z0-9:_-]/.test(c);

/** Left-to-right scan to find the state exactly at `at`. */
function scanTo(s: string, at: number): Scan {
  const st: Scan = { region: 'text', quote: '', inValue: false, attr: '', tag: '' };
  let tagState: TagState = 'between';
  let attrName = '';
  let i = 0;
  while (i < at) {
    const c = s[i]!;
    if (st.region === 'text') {
      if (s.startsWith('<!--', i)) {
        st.region = 'comment';
        i += 4;
        continue;
      }
      if (c === '<' && /[A-Za-z!/]/.test(s[i + 1] ?? '')) {
        let j = i + 1;
        if (s[j] === '/') j++;
        let name = '';
        while (j < s.length && isNameChar(s[j]!)) name += s[j++]!;
        st.region = 'tag';
        st.tag = name.toLowerCase();
        tagState = 'between';
        attrName = '';
        i = j;
        continue;
      }
      i++;
      continue;
    }
    if (st.region === 'comment') {
      if (s.startsWith('-->', i)) {
        st.region = 'text';
        i += 3;
      } else i++;
      continue;
    }
    if (st.region === 'script' || st.region === 'style') {
      const close = st.region === 'script' ? '</script' : '</style';
      if (s.slice(i, i + close.length).toLowerCase() === close) {
        st.region = 'text';
        i += close.length;
      } else i++;
      continue;
    }
    // region === 'tag' — a small sub-state machine.
    if (tagState === 'quoted') {
      if (c === st.quote) tagState = 'between';
      i++;
      continue;
    }
    if (tagState === 'unquoted') {
      if (/\s/.test(c)) tagState = 'between';
      else if (c === '>') closeTag(st);
      i++;
      continue;
    }
    if (c === '>') {
      closeTag(st);
      i++;
      continue;
    }
    if (tagState === 'preval') {
      if (/\s/.test(c)) {
        i++;
        continue;
      }
      if (c === '"' || c === "'") {
        st.quote = c;
        tagState = 'quoted';
      } else tagState = 'unquoted';
      i++;
      continue;
    }
    // tagState 'between' or 'name'
    if (/\s/.test(c)) {
      tagState = 'between';
      i++;
      continue;
    }
    if (c === '=') {
      tagState = 'preval';
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      // A quote with no '=' (rare/malformed): treat as a quoted value.
      st.quote = c;
      tagState = 'quoted';
      i++;
      continue;
    }
    if (tagState !== 'name') {
      tagState = 'name';
      attrName = '';
    }
    attrName += c.toLowerCase();
    i++;
  }
  if (st.region === 'tag') {
    st.inValue = tagState === 'quoted' || tagState === 'unquoted' || tagState === 'preval';
    st.attr = st.inValue || tagState === 'name' ? attrName : '';
    if (!st.inValue) st.quote = '';
  }
  return st;
}

function closeTag(st: Scan): void {
  st.region = st.tag === 'script' ? 'script' : st.tag === 'style' ? 'style' : 'text';
}

/** Narrow a tag-region scan and a script-region scan to a precise XssContext. */
function refine(s: string, at: number, st: Scan): { context: XssContext; attr?: string } {
  if (st.region === 'comment') return { context: 'comment' };
  if (st.region === 'style') return { context: 'css' };
  if (st.region === 'script') return { context: scriptStringState(s, at) };
  if (st.region === 'tag') {
    if (st.inValue) {
      const attr = st.attr;
      if (/^on/.test(attr)) return { context: 'event-handler', attr };
      if (URL_ATTRS.has(attr)) return { context: 'url', attr };
      if (attr === 'style') return { context: 'css', attr };
      if (st.quote === '"') return { context: 'attr-double', attr };
      if (st.quote === "'") return { context: 'attr-single', attr };
      return { context: 'attr-unquoted', attr };
    }
    return { context: 'tag', attr: st.tag };
  }
  return { context: 'html' };
}

/** Inside <script>: find the open string quote (if any) by scanning the script body to `at`. */
function scriptStringState(s: string, at: number): XssContext {
  // Find the start of the current script body.
  const before = s.slice(0, at).toLowerCase();
  const open = before.lastIndexOf('<script');
  const gt = open === -1 ? -1 : s.indexOf('>', open);
  const start = gt === -1 ? 0 : gt + 1;
  let quote: '"' | "'" | '`' | '' = '';
  for (let i = start; i < at; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '/' && s[i + 1] === '/') {
      const nl = s.indexOf('\n', i);
      if (nl === -1) break;
      i = nl;
    } else if (c === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i);
      if (end === -1) break;
      i = end + 1;
    }
  }
  if (quote === '"') return 'js-string-double';
  if (quote === "'") return 'js-string-single';
  if (quote === '`') return 'js-string-template';
  return 'js';
}

const ENTITY: Record<Special, RegExp> = {
  '<': /&lt;|&#0*60;|&#x0*3c;/i,
  '>': /&gt;|&#0*62;|&#x0*3e;/i,
  '"': /&quot;|&#0*34;|&#x0*22;|\\"/i,
  "'": /&#0*39;|&#x0*27;|&apos;|\\'/i,
  '`': /&#0*96;|&#x0*60;|\\`/i,
};

const reEscape = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Read how the probe characters came back in the text right after the marker. */
export function analyzeEscaping(trailing: string): Escaping {
  const raw: Special[] = [];
  const encoded: Special[] = [];
  for (const ch of SPECIAL) {
    // Raw = the bare character somewhere it is NOT backslash-escaped (so `\"` does not count).
    const bare = new RegExp(`(^|[^\\\\])${reEscape(ch)}`).test(trailing);
    const enc = ENTITY[ch].test(trailing);
    if (bare) raw.push(ch);
    else if (enc) encoded.push(ch);
  }
  return { raw, encoded };
}

const SNIPPET_BEFORE = 40;
const SNIPPET_AFTER = 40;

/** Every reflection of `marker`, classified, with the escaping of the probe that follows it. */
export function detectContexts(input: string, marker: string): Occurrence[] {
  if (!marker) return [];
  const out: Occurrence[] = [];
  let from = 0;
  for (;;) {
    const at = input.indexOf(marker, from);
    if (at === -1) break;
    const st = scanTo(input, at);
    const { context, attr } = refine(input, at, st);
    const after = input.slice(at + marker.length, at + marker.length + 32);
    const snippet = input
      .slice(Math.max(0, at - SNIPPET_BEFORE), at + marker.length + SNIPPET_AFTER)
      .replace(/\s+/g, ' ')
      .trim();
    out.push({ index: at, context, attr, snippet, escaping: analyzeEscaping(after) });
    from = at + marker.length;
    if (out.length >= 200) break;
  }
  return out;
}

/** The character you must get through unescaped to break out of a context. */
export function breakoutChar(context: XssContext): Special | null {
  switch (context) {
    case 'attr-double':
    case 'js-string-double':
      return '"';
    case 'attr-single':
    case 'js-string-single':
      return "'";
    case 'js-string-template':
      return '`';
    case 'html':
    case 'comment':
    case 'tag':
    case 'attr-unquoted':
      return '<';
    default:
      return null;
  }
}
