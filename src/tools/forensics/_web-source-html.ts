/**
 * A forgiving reader for HTML text: tags with their attributes, comments, and the raw-text
 * elements (<script>, <style>). There is no DOM in a worker, and none is wanted: the page is read
 * as text and never rendered, so nothing in it can run or load.
 *
 * What it keeps is what a person reading "view source" looks for: the files a page pulls in
 * (<script src>, <link href>, <img src>, <iframe src> and a few more), the comments (a classic
 * place for a flag), inline scripts and event-handler attributes (JavaScript to scan), and form
 * fields and meta tags (hidden fields).
 */
import type { HtmlRegions } from './_web-source-secrets';

export interface Attr {
  name: string;
  value: string;
  /** Offsets of the value (inside the quotes) in the page text. */
  start: number;
  end: number;
}

export interface Tag {
  name: string;
  attrs: Attr[];
  start: number;
  end: number;
}

export interface HtmlComment {
  /** The text between <!-- and -->. */
  text: string;
  /** Offsets of that text. */
  start: number;
  end: number;
}

export interface HtmlScript {
  tag: Tag;
  /** Offsets of the body; start === end for <script src>. */
  start: number;
  end: number;
}

export interface Parsed {
  tags: Tag[];
  comments: HtmlComment[];
  scripts: HtmlScript[];
  styles: { start: number; end: number }[];
}

const RAW_TEXT = new Set(['script', 'style']);

/** Parse the attributes of a start tag whose name ends at `i`; returns them and the index after `>`. */
function readAttrs(src: string, i: number): { attrs: Attr[]; end: number } {
  const attrs: Attr[] = [];
  const n = src.length;
  while (i < n) {
    while (i < n && /[\s/]/.test(src[i]!)) i++;
    if (i >= n) break;
    if (src[i] === '>') return { attrs, end: i + 1 };
    const nameStart = i;
    while (i < n && !/[\s=/>]/.test(src[i]!)) i++;
    if (i === nameStart) {
      i++; // a stray character: move on
      continue;
    }
    const name = src.slice(nameStart, i).toLowerCase();
    let j = i;
    while (j < n && /\s/.test(src[j]!)) j++;
    if (src[j] !== '=') {
      attrs.push({ name, value: '', start: i, end: i });
      continue;
    }
    j++;
    while (j < n && /\s/.test(src[j]!)) j++;
    const q = src[j];
    if (q === '"' || q === "'") {
      const close = src.indexOf(q, j + 1);
      const end = close < 0 ? n : close;
      attrs.push({ name, value: src.slice(j + 1, end), start: j + 1, end });
      i = close < 0 ? n : close + 1;
    } else {
      let k = j;
      while (k < n && !/[\s>]/.test(src[k]!)) k++;
      attrs.push({ name, value: src.slice(j, k), start: j, end: k });
      i = k;
    }
  }
  return { attrs, end: n };
}

export function parseHtml(src: string): Parsed {
  const out: Parsed = { tags: [], comments: [], scripts: [], styles: [] };
  const n = src.length;
  let i = 0;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    if (src.startsWith('<!--', lt)) {
      const close = src.indexOf('-->', lt + 4);
      const end = close < 0 ? n : close;
      out.comments.push({ text: src.slice(lt + 4, end), start: lt + 4, end });
      i = close < 0 ? n : close + 3;
      continue;
    }
    const c = src[lt + 1];
    if (c === '!' || c === '?' || c === '/') {
      const gt = src.indexOf('>', lt + 1);
      i = gt < 0 ? n : gt + 1;
      continue;
    }
    if (c === undefined || !/[A-Za-z]/.test(c)) {
      i = lt + 1;
      continue;
    }
    let j = lt + 1;
    while (j < n && /[A-Za-z0-9:_-]/.test(src[j]!)) j++;
    const name = src.slice(lt + 1, j).toLowerCase();
    const { attrs, end } = readAttrs(src, j);
    const tag: Tag = { name, attrs, start: lt, end };
    out.tags.push(tag);
    i = end;
    if (RAW_TEXT.has(name)) {
      const closeRe = new RegExp(`</${name}[\\s/>]`, 'ig');
      closeRe.lastIndex = end;
      const m = closeRe.exec(src);
      const bodyEnd = m ? m.index : n;
      if (name === 'script') out.scripts.push({ tag, start: end, end: bodyEnd });
      else out.styles.push({ start: end, end: bodyEnd });
      i = bodyEnd;
    }
  }
  return out;
}

// ---------- what to look at ----------

export interface Reference {
  /** What it is: script, stylesheet, icon, image, iframe, link, form, media, base, embed, redirect. */
  type: string;
  tag: string;
  attr: string;
  /** The value exactly as written. */
  url: string;
  /** Offset of the value in the page text. */
  at: number;
}

const REF_ATTRS: Record<string, string[]> = {
  script: ['src'],
  link: ['href'],
  img: ['src', 'srcset'],
  iframe: ['src'],
  frame: ['src'],
  a: ['href'],
  area: ['href'],
  form: ['action'],
  source: ['src', 'srcset'],
  video: ['src', 'poster'],
  audio: ['src'],
  track: ['src'],
  embed: ['src'],
  object: ['data'],
  base: ['href'],
  input: ['src', 'formaction'],
  button: ['formaction'],
};

function refType(tag: Tag, attr: string): string {
  switch (tag.name) {
    case 'link': {
      const rel = (tag.attrs.find((a) => a.name === 'rel')?.value ?? '').toLowerCase();
      if (rel.includes('stylesheet')) return 'stylesheet';
      if (rel.includes('icon')) return 'icon';
      if (rel.includes('preload') || rel.includes('modulepreload') || rel.includes('prefetch'))
        return 'preload';
      return 'link';
    }
    case 'a':
    case 'area':
      return 'link';
    case 'form':
    case 'input':
    case 'button':
      return attr === 'src' ? 'image' : 'form';
    case 'img':
      return 'image';
    case 'source':
    case 'video':
    case 'audio':
    case 'track':
      return 'media';
    case 'embed':
    case 'object':
      return 'embed';
    default:
      return tag.name;
  }
}

/** `srcset="a.png 1x, b.png 2x"` -> the URLs. */
const srcsetUrls = (v: string): string[] =>
  v
    .split(',')
    .map((x) => x.trim().split(/\s+/)[0] ?? '')
    .filter(Boolean);

export function references(parsed: Parsed): Reference[] {
  const refs: Reference[] = [];
  for (const tag of parsed.tags) {
    const wanted = REF_ATTRS[tag.name];
    if (wanted) {
      for (const a of tag.attrs) {
        if (!wanted.includes(a.name) || !a.value.trim()) continue;
        const urls = a.name === 'srcset' ? srcsetUrls(a.value) : [a.value.trim()];
        for (const url of urls) {
          refs.push({ type: refType(tag, a.name), tag: tag.name, attr: a.name, url, at: a.start });
        }
      }
    } else if (tag.name === 'meta') {
      const equiv = tag.attrs.find((a) => a.name === 'http-equiv')?.value.toLowerCase();
      const content = tag.attrs.find((a) => a.name === 'content');
      const m =
        equiv === 'refresh' && content ? /url\s*=\s*['"]?([^'";]+)/i.exec(content.value) : null;
      if (m)
        refs.push({
          type: 'redirect',
          tag: 'meta',
          attr: 'content',
          url: m[1]!.trim(),
          at: content!.start,
        });
    }
  }
  return refs;
}

/** Regions for the secret hunter: scripts and handlers to lex, comments, and form fields. */
export function regions(parsed: Parsed): HtmlRegions {
  const scripts: HtmlRegions['scripts'] = [];
  for (const s of parsed.scripts) {
    const type = (s.tag.attrs.find((a) => a.name === 'type')?.value ?? '').toLowerCase();
    // JSON, templates and other data blocks are not scripts, but their strings are worth reading.
    if (s.end > s.start && !/^(?:text\/(?:x-)?template|text\/html)$/.test(type)) {
      scripts.push({ start: s.start, end: s.end });
    }
  }
  const fields: HtmlRegions['fields'] = [];
  for (const tag of parsed.tags) {
    for (const a of tag.attrs) {
      if (/^on[a-z]+$/.test(a.name) && a.value) scripts.push({ start: a.start, end: a.end });
    }
    if (tag.name === 'input' || tag.name === 'textarea' || tag.name === 'meta') {
      const get = (n: string) => tag.attrs.find((a) => a.name === n);
      const value = tag.name === 'meta' ? get('content') : get('value');
      if (!value?.value) continue;
      const name =
        tag.name === 'meta'
          ? (get('name')?.value ?? get('property')?.value ?? '')
          : [get('name')?.value, get('id')?.value, get('placeholder')?.value]
              .filter(Boolean)
              .join(' ');
      fields.push({
        name,
        value: value.value,
        start: value.start,
        end: value.end,
        hidden: tag.name === 'input' && (get('type')?.value ?? '').toLowerCase() === 'hidden',
      });
    }
    // data-* attributes named like a secret.
    for (const a of tag.attrs) {
      if (a.name.startsWith('data-') && a.value) {
        fields.push({
          name: a.name.slice(5),
          value: a.value,
          start: a.start,
          end: a.end,
          hidden: false,
        });
      }
    }
  }
  return {
    scripts: scripts.sort((a, b) => a.start - b.start),
    styles: parsed.styles,
    comments: parsed.comments.map((c) => ({ start: c.start, end: c.end })),
    fields,
  };
}

/** A page that is a shell for a JavaScript app: little text, a mount point and scripts. */
export function looksLikeAppShell(src: string, parsed: Parsed): boolean {
  const hasScripts = parsed.scripts.some((s) => s.tag.attrs.some((a) => a.name === 'src'));
  if (!hasScripts) return false;
  const mount = /<div[^>]+id\s*=\s*["']?(?:root|app|__next|__nuxt|svelte|q-app|main)["']?/i.test(
    src,
  );
  const noscript =
    /enable javascript|requires javascript|doesn't work properly without javascript/i.test(src);
  if (!mount && !noscript) return false;
  const text = src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length < 240;
}
