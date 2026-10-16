import { describe, expect, it } from 'vitest';
import { looksLikeAppShell, parseHtml, references, regions } from './_web-source-html';

const attr = (html: string, tag: string, name: string) =>
  parseHtml(html)
    .tags.find((t) => t.name === tag)
    ?.attrs.find((a) => a.name === name);

describe('parseHtml: tags and attributes', () => {
  it('reads double-quoted, single-quoted and unquoted values, and valueless attributes', () => {
    const p = parseHtml(`<img src="a.png" alt='it''s' data-x=plain hidden width = 5 / >`);
    const img = p.tags[0]!;
    expect(img.name).toBe('img');
    expect(img.attrs.map((a) => [a.name, a.value])).toEqual([
      ['src', 'a.png'],
      ['alt', 'it'],
      ["'s'", ''],
      ['data-x', 'plain'],
      ['hidden', ''],
      ['width', '5'],
    ]);
  });

  it('lower-cases tag and attribute names and keeps the value as written', () => {
    const a = attr('<A HREF="/Admin?X=1">x</A>', 'a', 'href');
    expect(a?.value).toBe('/Admin?X=1');
  });

  it('gives the offsets of the value inside the quotes', () => {
    const html = 'xx <a href="/secret/page" class=c>y</a>';
    const a = attr(html, 'a', 'href')!;
    expect(html.slice(a.start, a.end)).toBe('/secret/page');
    const c = attr(html, 'a', 'class')!;
    expect(html.slice(c.start, c.end)).toBe('c');
  });

  it('is not fooled by a > inside a quoted value', () => {
    const p = parseHtml('<a title="1 > 0" href="/x">t</a><b id=after>');
    expect(p.tags.map((t) => t.name)).toEqual(['a', 'b']);
    expect(p.tags[0]!.attrs.find((a) => a.name === 'href')?.value).toBe('/x');
  });

  it('skips the doctype, processing instructions and end tags', () => {
    const p = parseHtml('<!DOCTYPE html><?xml version="1.0"?><p>x</p></p><br/>');
    expect(p.tags.map((t) => t.name)).toEqual(['p', 'br']);
  });

  it('survives broken markup', () => {
    for (const html of [
      '<',
      '<a',
      '<a href="unterminated',
      '<a href=>',
      '<!-- open',
      '<script>',
      '<<<>>>',
      '< p>',
    ]) {
      expect(() => parseHtml(html), html).not.toThrow();
    }
  });
});

describe('parseHtml: comments, scripts and styles', () => {
  it('collects comments, whole and with their offsets', () => {
    const html = 'a<!-- one -->b<!--\n multi\n line -->c<!--[if IE]><p>ie</p><![endif]-->';
    const p = parseHtml(html);
    expect(p.comments.map((c) => c.text)).toEqual([
      ' one ',
      '\n multi\n line ',
      '[if IE]><p>ie</p><![endif]',
    ]);
    for (const c of p.comments) expect(html.slice(c.start, c.end)).toBe(c.text);
  });

  it('keeps an unterminated comment to the end, and does not open tags inside a comment', () => {
    const p = parseHtml('<!-- <script>alert(1)</script> <img src=x onerror=alert(1)> -->');
    expect(p.tags).toEqual([]);
    expect(p.scripts).toEqual([]);
    expect(p.comments[0]!.text).toContain('<script>alert(1)</script>');
    expect(parseHtml('<!-- never closed <b>').comments[0]!.text).toBe(' never closed <b>');
  });

  it('reads a script body as raw text up to the first </script', () => {
    const html =
      '<script type="module">if (a < b && "</div>") {}\nvar s = "<b>";</script ><p>after</p>';
    const p = parseHtml(html);
    expect(p.scripts).toHaveLength(1);
    expect(html.slice(p.scripts[0]!.start, p.scripts[0]!.end)).toBe(
      'if (a < b && "</div>") {}\nvar s = "<b>";',
    );
    expect(p.tags.map((t) => t.name)).toEqual(['script', 'p']);
  });

  it('handles a script that ends the page, an empty one, and an uppercase end tag', () => {
    expect(parseHtml('<script>var a;').scripts[0]!.end).toBe('<script>var a;'.length);
    const empty = parseHtml('<script src="a.js"></script>').scripts[0]!;
    expect(empty.start).toBe(empty.end);
    const upper = parseHtml('<SCRIPT>x()</SCRIPT>');
    expect(upper.scripts).toHaveLength(1);
  });

  it('records style bodies apart from scripts', () => {
    const html = '<style>a{color:red}</style><p>x</p>';
    const p = parseHtml(html);
    expect(p.styles).toHaveLength(1);
    expect(html.slice(p.styles[0]!.start, p.styles[0]!.end)).toBe('a{color:red}');
    expect(p.scripts).toEqual([]);
  });
});

describe('references', () => {
  const refs = (html: string) =>
    references(parseHtml(html)).map((r) => [r.tag, r.attr, r.type, r.url]);

  it('lists script src, link href, img src and iframe src, in page order', () => {
    expect(
      refs(
        [
          '<link rel="stylesheet" href="/a.css"><link rel="icon" href="/f.ico"><link rel="preload" href="/p.js" as="script">',
          '<script src="/static/app.js"></script><img src="/logo.png"><iframe src="https://other.test/embed"></iframe>',
        ].join(''),
      ),
    ).toEqual([
      ['link', 'href', 'stylesheet', '/a.css'],
      ['link', 'href', 'icon', '/f.ico'],
      ['link', 'href', 'preload', '/p.js'],
      ['script', 'src', 'script', '/static/app.js'],
      ['img', 'src', 'image', '/logo.png'],
      ['iframe', 'src', 'iframe', 'https://other.test/embed'],
    ]);
  });

  it('also lists links, form actions, media, objects, base and a meta refresh', () => {
    expect(
      refs(
        '<a href="/admin">a</a><form action="/login"></form><video src="/v.mp4" poster="/p.jpg"></video>' +
          '<object data="/o.swf"></object><base href="/base/"><meta http-equiv="refresh" content="5; url=/next">',
      ),
    ).toEqual([
      ['a', 'href', 'link', '/admin'],
      ['form', 'action', 'form', '/login'],
      ['video', 'src', 'media', '/v.mp4'],
      ['video', 'poster', 'media', '/p.jpg'],
      ['object', 'data', 'embed', '/o.swf'],
      ['base', 'href', 'base', '/base/'],
      ['meta', 'content', 'redirect', '/next'],
    ]);
  });

  it('splits a srcset and skips empty values', () => {
    expect(
      refs('<img srcset="a.png 1x, b.png 2x" src=""><a href=" ">x</a>').map((r) => r[3]),
    ).toEqual(['a.png', 'b.png']);
  });

  it('keeps a javascript: URL as the text it is', () => {
    expect(refs('<a href="javascript:alert(1)">x</a>')[0]![3]).toBe('javascript:alert(1)');
  });
});

describe('regions for the secret hunter', () => {
  it('lists scripts, on* handlers, comments, styles and fields', () => {
    const html = [
      '<!-- c -->',
      '<style>p{}</style>',
      '<input type="hidden" name="tok" value="v1">',
      '<input id="who" placeholder="Name" value="v2">',
      '<meta name="secret" content="v3">',
      '<div data-token="v4" data-empty="">',
      '<button onclick="go(\'x\')">b</button>',
      '<script>var a = 1;</script>',
      '<script type="text/template"><p>{{x}}</p></script>',
    ].join('\n');
    const r = regions(parseHtml(html));
    expect(r.scripts.map((s) => html.slice(s.start, s.end))).toEqual(["go('x')", 'var a = 1;']);
    expect(r.comments.map((s) => html.slice(s.start, s.end))).toEqual([' c ']);
    expect(r.styles.map((s) => html.slice(s.start, s.end))).toEqual(['p{}']);
    expect(r.fields.map((f) => [f.name, f.value, f.hidden])).toEqual([
      ['tok', 'v1', true],
      ['who Name', 'v2', false],
      ['secret', 'v3', false],
      ['token', 'v4', false],
    ]);
    for (const f of r.fields) expect(html.slice(f.start, f.end)).toBe(f.value);
  });
});

describe('looksLikeAppShell', () => {
  const shell = (html: string) => looksLikeAppShell(html, parseHtml(html));

  it('recognises the empty page of a JavaScript app', () => {
    expect(
      shell(
        '<html><body><div id="root"></div><script src="/static/js/main.js"></script></body></html>',
      ),
    ).toBe(true);
    expect(
      shell(
        '<body><noscript>You need to enable JavaScript to run this app.</noscript><div id="app"></div><script src="a.js"></script></body>',
      ),
    ).toBe(true);
  });

  it('does not take a page with real text, or without scripts, for a shell', () => {
    expect(
      shell(`<div id="root">${'A real article. '.repeat(30)}</div><script src="a.js"></script>`),
    ).toBe(false);
    expect(shell('<div id="root"></div>')).toBe(false);
    expect(shell('<p>hello</p><script src="a.js"></script>')).toBe(false);
  });
});
