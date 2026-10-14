import { selectFlags } from '../core/flags';
import { getTool, TOOLS } from '../core/registry';
import { CATEGORIES, type AnyTool, type Sample } from '../core/types';
import { isValidUtf8, printableRatio, utf8Decode, utf8Encode } from '../lib/bytes';
import { clear, copyText, debounce, h } from './dom';
import { flagSettings } from './settings';
import { renderTool, setPending } from './tool-view';

const search = (q: string): AnyTool[] => {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...TOOLS];
  return TOOLS.filter((t) => {
    const hay = [t.id, t.name, t.description, ...(t.tags ?? [])].join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
};

export function mountApp(root: HTMLElement): void {
  const nav = h('nav', { class: 'toollist', 'aria-label': 'Tools' });
  const main = h('main', { class: 'main', id: 'main', tabindex: '-1' });
  const searchBox = h('input', {
    type: 'search',
    class: 'search',
    placeholder: 'Search tools',
    'aria-label': 'Search tools',
    'aria-keyshortcuts': '/',
    autocomplete: 'off',
    spellcheck: false,
    oninput: () => renderNav(),
    onkeydown: (ev: KeyboardEvent) => {
      if (ev.key === 'Enter') {
        const first = search(searchBox.value)[0];
        if (first) location.hash = `#/tool/${first.id}`;
      } else if (ev.key === 'Escape') {
        searchBox.value = '';
        renderNav();
        searchBox.blur();
      }
    },
  });
  const sidebar = h(
    'aside',
    { class: 'sidebar', id: 'sidebar' },
    h(
      'a',
      { class: 'brand', href: '#/' },
      h('span', { class: 'pennant', 'aria-hidden': 'true' }),
      h('span', null, 'find the flag'),
    ),
    h(
      'div',
      { class: 'search-wrap' },
      searchBox,
      h('kbd', { class: 'search-kbd', 'aria-hidden': 'true' }, '/'),
    ),
    nav,
    settingsPanel(),
  );
  const menuBtn = h(
    'button',
    {
      type: 'button',
      class: 'menu-btn',
      'aria-controls': 'sidebar',
      'aria-expanded': 'false',
      onclick: () => {
        const open = root.classList.toggle('nav-open');
        menuBtn.setAttribute('aria-expanded', String(open));
      },
    },
    'Tools',
  );
  const topbar = h(
    'header',
    { class: 'topbar' },
    h(
      'a',
      { class: 'brand', href: '#/' },
      h('span', { class: 'pennant', 'aria-hidden': 'true' }),
      h('span', null, 'find the flag'),
    ),
    menuBtn,
  );
  root.append(h('a', { class: 'skip', href: '#main' }, 'Skip to content'), topbar, sidebar, main);

  let current = '';
  function renderNav() {
    clear(nav);
    const found = new Set(search(searchBox.value).map((t) => t.id));
    for (const cat of CATEGORIES) {
      const tools = TOOLS.filter((t) => t.category === cat.id && found.has(t.id));
      if (!tools.length) continue;
      nav.append(
        h(
          'div',
          { class: 'navgroup' },
          h(
            'h2',
            null,
            h('span', { class: `glyph glyph-${cat.id}`, 'aria-hidden': 'true' }),
            cat.name,
          ),
          h(
            'ul',
            null,
            ...tools.map((t) =>
              h(
                'li',
                null,
                h(
                  'a',
                  { href: `#/tool/${t.id}`, 'aria-current': t.id === current ? 'page' : undefined },
                  t.name,
                ),
              ),
            ),
          ),
        ),
      );
    }
    if (!found.size)
      nav.append(h('p', { class: 'nav-empty' }, 'No tool matches. Try another word.'));
  }

  let teardown: (() => void) | null = null;
  function route() {
    teardown?.();
    teardown = null;
    clear(main);
    root.classList.remove('nav-open');
    menuBtn.setAttribute('aria-expanded', 'false');
    const m = location.hash.match(/^#\/tool\/([a-z0-9-]+)/);
    const tool = m ? getTool(m[1]!) : undefined;
    current = tool?.id ?? '';
    if (tool) {
      document.title = `${tool.name} · Find The Flag`;
      teardown = renderTool(tool, main, (id) => (location.hash = `#/tool/${id}`));
    } else {
      document.title = 'Find The Flag — CTF toolbox';
      renderHome(main);
    }
    renderNav();
    main.scrollTo?.(0, 0);
  }

  document.addEventListener('keydown', (ev) => {
    const t = ev.target as HTMLElement;
    const typing = t.closest('input, textarea, select, [contenteditable]');
    if (ev.key === '/' && !typing) {
      ev.preventDefault();
      searchBox.focus();
      searchBox.select();
    }
  });
  window.addEventListener('hashchange', route);
  route();
}

function settingsPanel(): HTMLElement {
  const input = h('input', {
    type: 'text',
    class: 'flag-pattern',
    value: flagSettings.pattern,
    placeholder: String.raw`e.g. RM\{[^}]+\}`,
    spellcheck: false,
    'aria-label': 'Extra flag pattern (regular expression)',
    onchange: () => flagSettings.set(input.value),
  });
  return h(
    'details',
    { class: 'settings' },
    h('summary', null, 'Flag format'),
    h(
      'p',
      null,
      'Outputs are scanned for prefix{…}. Add your event’s format as a regular expression:',
    ),
    input,
    h(
      'p',
      { class: 'fine' },
      'Saved in this browser only. Find The Flag runs entirely client-side: no server, no tracking.',
    ),
  );
}

// ---------- home: triage ----------

function sampleFrom(text: string | null, bytes: Uint8Array, name?: string): Sample {
  return { text, bytes, name };
}

function rank(sample: Sample) {
  const out: {
    tool: AnyTool;
    score: number;
    reason?: string;
    options?: Record<string, unknown>;
  }[] = [];
  for (const tool of TOOLS) {
    if (!tool.detect) continue;
    if (sample.text === null && tool.input === 'text') continue;
    try {
      const d = tool.detect(sample);
      if (d && d.score >= 0.25)
        out.push({ tool, score: d.score, reason: d.reason, options: d.options });
    } catch {
      // A detector that throws simply does not vote.
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 8);
}

function renderHome(main: HTMLElement) {
  let file: { bytes: Uint8Array; name: string } | null = null;
  const results = h('div', { class: 'triage-results', 'aria-live': 'polite' });
  const fileInput = h('input', {
    type: 'file',
    hidden: true,
    onchange: () => {
      const f = fileInput.files?.[0];
      if (f) void takeFile(f);
      fileInput.value = '';
    },
  });
  const ta = h('textarea', {
    class: 'triage-input',
    spellcheck: false,
    autocomplete: 'off',
    placeholder: 'Paste a string you found, or drop a file here.',
    'aria-label': 'Paste data to identify',
    oninput: debounce(() => {
      file = null;
      update();
    }, 120),
  });

  async function takeFile(f: File) {
    file = { bytes: new Uint8Array(await f.arrayBuffer()), name: f.name };
    ta.value = '';
    update();
  }

  function update() {
    clear(results);
    let sample: Sample;
    if (file) {
      const textual = isValidUtf8(file.bytes) && printableRatio(file.bytes) > 0.9;
      sample = sampleFrom(textual ? utf8Decode(file.bytes) : null, file.bytes, file.name);
      results.append(h('p', { class: 'triage-file' }, `${file.name} · ${file.bytes.length} bytes`));
    } else {
      const text = ta.value.trim();
      if (!text) return;
      sample = sampleFrom(text, utf8Encode(text));
    }
    const flags = sample.text
      ? [...selectFlags(sample.text, flagSettings.regex, flagSettings.pattern)].slice(0, 5)
      : [];
    if (flags.length) {
      results.append(
        h(
          'div',
          { class: 'flag-strip' },
          h('span', { class: 'flag-strip-label' }, 'Already a flag'),
          ...flags.map((f) => {
            const b: HTMLButtonElement = h(
              'button',
              { type: 'button', class: 'flag-chip', onclick: () => copyText(f, b) },
              f,
            );
            return b;
          }),
        ),
      );
    }
    const ranked = rank(sample);
    if (!ranked.length) {
      results.append(
        h(
          'p',
          { class: 'empty' },
          'No tool recognises this. Try Auto-decode, Strings, or browse the tools below.',
        ),
      );
      return;
    }
    results.append(
      h('h2', { class: 'triage-h' }, 'Looks like'),
      h(
        'ol',
        { class: 'guesses' },
        ...ranked.map((r) =>
          h(
            'li',
            null,
            h(
              'button',
              {
                type: 'button',
                class: 'guess',
                onclick: () => {
                  setPending(
                    r.tool.id,
                    file ? { bytes: file.bytes, name: file.name } : { text: sample.text ?? '' },
                    r.options,
                  );
                  location.hash = `#/tool/${r.tool.id}`;
                },
              },
              h('span', {
                class: 'guess-bar',
                style: `--score:${Math.round(r.score * 100)}%`,
                'aria-hidden': 'true',
              }),
              h('span', { class: 'guess-name' }, r.tool.name),
              h('span', { class: 'guess-why' }, r.reason ?? r.tool.description),
              h('span', { class: 'guess-score' }, `${Math.round(r.score * 100)}%`),
            ),
          ),
        ),
      ),
    );
  }

  const drop = h(
    'div',
    {
      class: 'triage',
      ondragover: (ev: DragEvent) => {
        ev.preventDefault();
        drop.classList.add('is-dragging');
      },
      ondragleave: () => drop.classList.remove('is-dragging'),
      ondrop: (ev: DragEvent) => {
        ev.preventDefault();
        drop.classList.remove('is-dragging');
        const f = ev.dataTransfer?.files?.[0];
        if (f) void takeFile(f);
      },
    },
    ta,
    h(
      'div',
      { class: 'input-bar' },
      h(
        'button',
        { type: 'button', class: 'btn btn-ghost', onclick: () => fileInput.click() },
        'Open file',
      ),
      h('span', { class: 'fine' }, 'Nothing is uploaded. Every tool runs in this tab.'),
    ),
    fileInput,
  );

  main.append(
    h(
      'section',
      { class: 'home' },
      h('h1', { class: 'home-title' }, 'What did you find?'),
      h(
        'p',
        { class: 'home-lede' },
        `${TOOLS.length} tools for decoding, cracking and digging through CTF challenge files. Paste or drop anything to get a guess.`,
      ),
      drop,
      results,
      h(
        'div',
        { class: 'index' },
        ...CATEGORIES.map((cat) => {
          const tools = TOOLS.filter((t) => t.category === cat.id);
          if (!tools.length) return null;
          return h(
            'section',
            { class: 'index-cat' },
            h(
              'h2',
              null,
              h('span', { class: `glyph glyph-${cat.id}`, 'aria-hidden': 'true' }),
              cat.name,
            ),
            h('p', { class: 'index-blurb' }, cat.blurb),
            h(
              'ul',
              null,
              ...tools.map((t) =>
                h(
                  'li',
                  null,
                  h(
                    'a',
                    { href: `#/tool/${t.id}` },
                    h('span', null, t.name),
                    h('small', null, t.description),
                  ),
                ),
              ),
            ),
          );
        }),
      ),
    ),
  );
}
