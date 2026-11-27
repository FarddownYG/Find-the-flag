import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '../i18n';
import { mapBlock } from './map';
import { externalLink, linkOrText, safeHttpUrl } from './links';
import { holdFile, isHoldingFile } from './unload-guard';

/** The smallest DOM the `h()` builder and the glyph need: enough to inspect attributes and text. */
class FakeNode {
  children: FakeNode[] = [];
  attrs = new Map<string, string>();
  className = '';
  textContent = '';
  constructor(readonly tag: string) {}
  setAttribute(k: string, v: string) {
    this.attrs.set(k, v);
  }
  getAttribute(k: string) {
    return this.attrs.get(k) ?? null;
  }
  appendChild(c: FakeNode) {
    this.children.push(c);
    return c;
  }
  addEventListener() {}
  text(): string {
    return this.tag === '#text' ? this.textContent : this.children.map((c) => c.text()).join('');
  }
  find(tag: string): FakeNode[] {
    return [...(this.tag === tag ? [this] : []), ...this.children.flatMap((c) => c.find(tag))];
  }
}

beforeEach(() => {
  vi.stubGlobal('document', {
    createElement: (tag: string) => new FakeNode(tag),
    createElementNS: (_ns: string, tag: string) => new FakeNode(tag),
    createTextNode: (s: string) => Object.assign(new FakeNode('#text'), { textContent: s }),
  });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await setLocale('en');
});

const asNode = (a: HTMLAnchorElement) => a as unknown as FakeNode;

/** The guard: every link the helper makes must open a new tab without opener or referrer. */
function assertSafeExternal(a: FakeNode) {
  expect(a.getAttribute('target')).toBe('_blank');
  const rel = (a.getAttribute('rel') ?? '').split(/\s+/);
  expect(rel).toContain('noopener');
  expect(rel).toContain('noreferrer');
}

describe('externalLink', () => {
  it('opens a new tab with no opener and no referrer, with an icon and a screen-reader note', () => {
    const a = asNode(externalLink('https://example.org/x', 'Example', { class: 'btn' }));
    assertSafeExternal(a);
    expect(a.getAttribute('href')).toBe('https://example.org/x');
    expect(a.find('svg')).toHaveLength(1);
    expect(a.text()).toContain('Example');
    expect(a.text()).toContain('(opens in a new tab)');
  });

  it('keeps an in-app route in the same tab (a plain anchor, never _blank)', () => {
    const internal = document.createElement('a') as unknown as FakeNode;
    internal.setAttribute('href', '#/tool/metadata');
    expect(internal.getAttribute('target')).toBeNull();
  });

  it('is the only place in src/ui and src/tools that writes target _blank', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (
          /\.ts$/.test(name) &&
          !/\.test\.ts$/.test(name) &&
          name !== 'links.ts' &&
          /target\s*[:=]\s*['"]_blank['"]/.test(readFileSync(p, 'utf8'))
        )
          offenders.push(p);
      }
    };
    walk(new URL('.', import.meta.url).pathname);
    walk(new URL('../tools', import.meta.url).pathname);
    expect(offenders).toEqual([]);
  });
});

describe('URLs found in a file', () => {
  it('only http(s) is clickable', () => {
    expect(safeHttpUrl('https://example.org/a?b=1')).toBe('https://example.org/a?b=1');
    expect(safeHttpUrl('http://example.org')).toBe('http://example.org/');
    for (const bad of [
      'javascript:alert(1)',
      ' JavaScript:alert(1)',
      'data:text/html,<script>1</script>',
      'file:///etc/passwd',
      'vbscript:x',
      '//example.org',
      'not a url',
    ])
      expect(safeHttpUrl(bad)).toBeNull();
  });

  it('renders anything else as inert text', () => {
    expect(linkOrText('javascript:alert(1)')).toBe('javascript:alert(1)');
    const link = linkOrText('https://example.org/');
    expect(typeof link).toBe('object');
    assertSafeExternal(link as unknown as FakeNode);
  });
});

describe('unload guard', () => {
  it('is armed only while a file is held', () => {
    const owner = Symbol('t');
    vi.stubGlobal('window', { addEventListener: vi.fn() });
    expect(isHoldingFile()).toBe(false);
    holdFile(owner, true);
    expect(isHoldingFile()).toBe(true);
    holdFile(owner, false);
    expect(isHoldingFile()).toBe(false);
  });
});

describe('mapBlock', () => {
  const block = (o: Parameters<typeof mapBlock>[0]) => mapBlock(o) as unknown as FakeNode;
  const anchors = (n: FakeNode) => n.find('a');

  it('shows decimal and DMS with copy buttons, two safe map links and the privacy line', () => {
    const n = block({ type: 'map', lat: 48.8584, lon: -2.2945 });
    const text = n.text();
    expect(text).toContain('48.858400, -2.294500');
    expect(text).toContain('48° 51′ 30.24″ N');
    expect(text).toContain('2° 17′ 40.20″ W');
    expect(text).toContain('Opening a map sends these coordinates to the chosen service.');
    expect(n.find('button').filter((b) => b.text() === 'Copy')).toHaveLength(2);
    const links = anchors(n);
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      'https://www.google.com/maps/search/?api=1&query=48.858400,-2.294500',
      'https://www.openstreetmap.org/?mlat=48.858400&mlon=-2.294500#map=17/48.858400/-2.294500',
    ]);
    for (const a of links) assertSafeExternal(a);
  });

  it('warns on 0, 0 but keeps the coordinates and links', () => {
    const n = block({ type: 'map', lat: 0, lon: 0, problem: 'zero' });
    expect(n.text()).toContain('probably fake');
    expect(anchors(n)).toHaveLength(2);
  });

  it('offers no link at all for an impossible latitude', () => {
    const n = block({ type: 'map', lat: 123, lon: 10, problem: 'range' });
    expect(n.text()).toContain('123.000000, 10.000000');
    expect(anchors(n)).toHaveLength(0);
    expect(n.find('p').some((p) => p.className === 'map-links')).toBe(false);
  });
});
