import { describe, expect, it } from 'vitest';
import type { Output } from '../../core/types';
import { resultToText } from '../../core/result-text';
import html, {
  HTML_ENTITY_NAMES,
  htmlDecode,
  htmlDecodeBytes,
  htmlDecodeDetailed,
  htmlEncode,
} from './html-entities';

describe('html entities: table', () => {
  it('knows well over 100 names, with correct code points for samples', () => {
    expect(HTML_ENTITY_NAMES.size).toBeGreaterThan(200);
    const sample: [string, number][] = [
      ['amp', 38], ['lt', 60], ['gt', 62], ['quot', 34], ['apos', 39], ['nbsp', 160],
      ['copy', 169], ['reg', 174], ['eacute', 233], ['Eacute', 201], ['szlig', 223],
      ['yuml', 255], ['divide', 247], ['times', 215], ['euro', 8364], ['hellip', 8230],
      ['mdash', 8212], ['trade', 8482], ['alpha', 945], ['Omega', 937], ['Sigma', 931],
      ['sigmaf', 962], ['rarr', 8594], ['infin', 8734], ['hearts', 9829], ['lbrace', 123],
    ]; // prettier-ignore
    for (const [name, code] of sample) expect(HTML_ENTITY_NAMES.get(name)).toBe(code);
  });

  it('covers the whole Latin-1 block contiguously', () => {
    const names = [...HTML_ENTITY_NAMES].filter(([, c]) => c >= 160 && c <= 255);
    expect(new Set(names.map(([, c]) => c)).size).toBe(96);
  });
});

describe('html entities: decode', () => {
  it('decodes named, decimal and hex entities', () => {
    expect(htmlDecode('&lt;b&gt;Tom &amp; Jerry&lt;/b&gt;')).toBe('<b>Tom & Jerry</b>');
    expect(htmlDecode('&quot;hi&quot; &apos;there&apos;')).toBe('"hi" \'there\'');
    expect(htmlDecode('a&nbsp;b')).toBe('a b');
    expect(htmlDecode('caf&eacute; &Eacute;t&eacute; na&iuml;ve &ntilde;')).toBe(
      'café Été naïve ñ',
    );
    expect(htmlDecode('&#102;&#108;&#97;&#103;')).toBe('flag');
    expect(htmlDecode('&#x66;&#X6C;&#x61;&#x67;')).toBe('flag');
    expect(htmlDecode('&#128512; &#x1F600;')).toBe('😀 😀');
  });

  it('is case sensitive for names', () => {
    expect(htmlDecode('&Aacute;&aacute;')).toBe('Áá');
    expect(htmlDecodeDetailed('&AMP;').unknown).toEqual(['&AMP;']);
  });

  it('accepts a missing semicolon for numbers and known names', () => {
    expect(htmlDecode('&#102&#108ag')).toBe('flag');
    expect(htmlDecode('1 &lt 2')).toBe('1 < 2');
  });

  it('does not eat query-string parameters that look like entities', () => {
    expect(htmlDecode('?a=1&copy=2&lt=3')).toBe('?a=1&copy=2&lt=3');
    expect(htmlDecode('?a=1&copy;=2')).toBe('?a=1©=2');
  });

  it('leaves unknown names and impossible numbers untouched and reports them', () => {
    const r = htmlDecodeDetailed('&bogus; &#0; &#99999999; &amp;');
    expect(r.text).toBe('&bogus; &#0; &#99999999; &');
    expect(r.count).toBe(1);
    expect(r.unknown).toEqual(['&bogus;', '&#0;', '&#99999999;']);
  });

  it('decodes HTML5 punctuation names used in XSS payloads', () => {
    expect(htmlDecode('alert&lpar;1&rpar;&semi;&NewLine;x&Tab;y&colon;&sol;&sol;')).toBe(
      'alert(1);\nx\ty://',
    );
  });

  it('does not decode twice (&amp;lt; becomes &lt;)', () => {
    expect(htmlDecode('&amp;lt;')).toBe('&lt;');
    expect(htmlDecode('&#38;#102;')).toBe('&#102;');
  });

  it('handles plain text and empty input', () => {
    expect(htmlDecode('no entities & stuff')).toBe('no entities & stuff');
    expect(htmlDecode('')).toBe('');
  });

  it('bytes helper encodes as UTF-8', () => {
    expect(Array.from(htmlDecodeBytes('&eacute;'))).toEqual([0xc3, 0xa9]);
  });
});

describe('html entities: encode', () => {
  it('special: only the five markup characters', () => {
    expect(htmlEncode(`<a href="x">Tom & 'Jerry' é</a>`, 'special')).toBe(
      '&lt;a href=&quot;x&quot;&gt;Tom &amp; &apos;Jerry&apos; é&lt;/a&gt;',
    );
  });

  it('nonascii (default): names where they exist, decimal otherwise', () => {
    expect(htmlEncode('é © € ✓ 😀 <')).toBe('&eacute; &copy; &euro; &check; &#128512; &lt;');
    expect(htmlEncode('é ☃', 'nonascii', 'decimal')).toBe('&#233; &#9731;');
    expect(htmlEncode('é ☃', 'nonascii', 'hex')).toBe('&#xE9; &#x2603;');
  });

  it('all: every character, even letters', () => {
    expect(htmlEncode('flag', 'all', 'decimal')).toBe('&#102;&#108;&#97;&#103;');
    expect(htmlEncode('a<', 'all', 'named')).toBe('&#97;&lt;');
    expect(htmlEncode('{x}', 'all', 'hex')).toBe('&#x7B;&#x78;&#x7D;');
  });

  it('round-trips in every scope and style', () => {
    const text = '<p class="a">Ünïcödé & ✓ 😀 ‘quotes’ — 日本語 αβγ {flag} \'x\'</p>\nline 2\ttab';
    for (const scope of ['special', 'nonascii', 'all'] as const) {
      for (const format of ['named', 'decimal', 'hex'] as const) {
        expect(htmlDecode(htmlEncode(text, scope, format))).toBe(text);
      }
    }
  });
});

describe('html entities tool', () => {
  const run = (text: string, options: Record<string, unknown> = {}) =>
    html.run(text, {
      mode: 'decode',
      scope: 'nonascii',
      format: 'named',
      ...options,
    } as never) as Output[];

  it('decodes and warns about leftovers', () => {
    expect(run('&lt;&bogus;&gt;')[0]).toEqual({ type: 'text', value: '<&bogus;>' });
    expect(resultToText(run('&lt;&bogus;&gt;'))).toContain('&bogus;');
    expect(resultToText(run('nothing'))).toContain('No HTML entities');
  });

  it('encodes', () => {
    expect(run('a<b', { mode: 'encode' })).toEqual([{ type: 'text', value: 'a&lt;b' }]);
  });

  it('detect: entity soup scores higher than a lone entity; plain text is null', () => {
    const sample = (text: string) => ({ text, bytes: new Uint8Array() });
    expect(html.detect!(sample('&#102;&#108;&#97;&#103;'))?.score).toBeGreaterThan(0.9);
    expect(html.detect!(sample('Tom &amp; Jerry went home'))?.score).toBeLessThan(0.7);
    expect(html.detect!(sample('Tom & Jerry'))).toBeNull();
    expect(html.detect!(sample('&bogus;'))).toBeNull();
  });
});
