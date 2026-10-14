import { selectFlags } from '../core/flags';
import { getTool, TOOLS } from '../core/registry';
import { CATEGORIES, type AnyTool, type Sample } from '../core/types';
import { getLocale, LOCALES, isLocale, onLocaleChange, setLocale, t } from '../i18n';
import { categoryBlurb, categoryName, toolDescription, toolName } from '../i18n/tool-text';
import { isValidUtf8, printableRatio, utf8Decode, utf8Encode } from '../lib/bytes';
import { clear, copyText, debounce, h } from './dom';
import { flagSettings } from './settings';
import { renderTool, setPending } from './tool-view';

/** Rank tools for a query: exact names/aliases first, then prefixes, then any mention. */
function matchScore(tool: AnyTool, w: string): number {
  // Both the English name and the translated one match, so aliases keep working in any language.
  const names = [tool.name, toolName(tool)].map((x) => x.toLowerCase());
  const tags = (tool.tags ?? []).map((x) => x.toLowerCase());
  const desc = `${tool.description} ${toolDescription(tool)}`.toLowerCase();
  if (tool.id === w || names.includes(w) || tags.includes(w)) return 100;
  if (names.some((n) => n.startsWith(w)) || tool.id.startsWith(w)) return 80;
  if (tags.some((x) => x.startsWith(w))) return 70;
  if (names.some((n) => n.includes(w))) return 60;
  if (tags.some((x) => x.includes(w))) return 50;
  if (desc.includes(w)) return 20;
  return 0;
}

const search = (q: string): AnyTool[] => {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...TOOLS];
  return TOOLS.map((t, i) => {
    const scores = words.map((w) => matchScore(t, w));
    return { t, i, score: Math.min(...scores) && scores.reduce((a, b) => a + b, 0) };
  })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((r) => r.t);
};

export function mountApp(root: HTMLElement): void {
  const main = h('main', { class: 'main', id: 'main', tabindex: '-1' });
  let nav = h('nav');
  let searchBox = h('input');
  let menuBtn = h('button');
  let current = '';

  /** Everything around <main>; rebuilt when the language changes. */
  function buildChrome(): Node[] {
    nav = h('nav', { class: 'toollist', 'aria-label': t('ui.nav.label') });
    searchBox = h('input', {
      type: 'search',
      class: 'search',
      placeholder: t('ui.search.placeholder'),
      'aria-label': t('ui.search.placeholder'),
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
    const brand = () =>
      h(
        'a',
        { class: 'brand', href: '#/' },
        h('span', { class: 'pennant', 'aria-hidden': 'true' }),
        h('span', null, 'find the flag'),
      );
    const sidebar = h(
      'aside',
      { class: 'sidebar', id: 'sidebar' },
      h('div', { class: 'sidebar-head' }, brand(), languagePicker('lang-side')),
      h(
        'div',
        { class: 'search-wrap' },
        searchBox,
        h('kbd', { class: 'search-kbd', 'aria-hidden': 'true' }, '/'),
      ),
      nav,
      settingsPanel(),
    );
    menuBtn = h(
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
      t('ui.nav.menu'),
    );
    const topbar = h(
      'header',
      { class: 'topbar' },
      brand(),
      h('div', { class: 'topbar-actions' }, languagePicker('lang-top'), menuBtn),
    );
    return [h('a', { class: 'skip', href: '#main' }, t('ui.skip')), topbar, sidebar];
  }

  function renderNav() {
    clear(nav);
    const found = new Set(search(searchBox.value).map((x) => x.id));
    for (const cat of CATEGORIES) {
      const tools = TOOLS.filter((x) => x.category === cat.id && found.has(x.id));
      if (!tools.length) continue;
      nav.append(
        h(
          'div',
          { class: 'navgroup' },
          h(
            'h2',
            null,
            h('span', { class: `glyph glyph-${cat.id}`, 'aria-hidden': 'true' }),
            categoryName(cat.id),
          ),
          h(
            'ul',
            null,
            ...tools.map((x) =>
              h(
                'li',
                null,
                h(
                  'a',
                  { href: `#/tool/${x.id}`, 'aria-current': x.id === current ? 'page' : undefined },
                  toolName(x),
                ),
              ),
            ),
          ),
        ),
      );
    }
    if (!found.size) nav.append(h('p', { class: 'nav-empty' }, t('ui.search.none')));
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
      document.title = `${toolName(tool)} · Find The Flag`;
      teardown = renderTool(tool, main, (id) => (location.hash = `#/tool/${id}`));
    } else {
      document.title = t('ui.title');
      renderHome(main);
    }
    renderNav();
    main.scrollTo?.(0, 0);
  }

  function render() {
    root.replaceChildren(...buildChrome(), main);
    route();
  }

  document.addEventListener('keydown', (ev) => {
    const target = ev.target as HTMLElement;
    const typing = target.closest('input, textarea, select, [contenteditable]');
    if (ev.key === '/' && !typing) {
      ev.preventDefault();
      searchBox.focus();
      searchBox.select();
    }
  });
  window.addEventListener('hashchange', route);
  onLocaleChange(render);
  render();
}

function languagePicker(id: string): HTMLElement {
  const sel = h(
    'select',
    {
      id,
      class: 'lang',
      onchange: () => {
        if (isLocale(sel.value)) void setLocale(sel.value, { remember: true });
      },
    },
    ...LOCALES.map((l) =>
      h('option', { value: l.id, selected: l.id === getLocale(), lang: l.id }, l.name),
    ),
  );
  return h(
    'label',
    { class: 'lang-wrap', for: id },
    h('span', { class: 'visually-hidden' }, t('ui.lang.label')),
    h('span', { class: 'lang-icon', 'aria-hidden': 'true' }, '文A'),
    sel,
  );
}

function settingsPanel(): HTMLElement {
  const input = h('input', {
    type: 'text',
    class: 'flag-pattern',
    value: flagSettings.pattern,
    placeholder: t('ui.flagFormat.placeholder', { example: String.raw`RM\{[^}]+\}` }),
    spellcheck: false,
    'aria-label': t('ui.flagFormat.inputLabel'),
    onchange: () => flagSettings.set(input.value),
  });
  return h(
    'details',
    { class: 'settings' },
    h('summary', null, t('ui.flagFormat.title')),
    h('p', null, t('ui.flagFormat.help')),
    input,
    h('p', { class: 'fine' }, t('ui.flagFormat.privacy')),
  );
}

// ---------- home: triage ----------

const TRIAGE_READ_LIMIT = 8 * 1024 * 1024;

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
  let file: { bytes: Uint8Array; name: string; handle: File } | null = null;
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
    placeholder: t('ui.home.placeholder'),
    'aria-label': t('ui.home.inputLabel'),
    oninput: debounce(() => {
      file = null;
      update();
    }, 120),
  });

  async function takeFile(f: File) {
    // Detectors only need the start of a big file; the full handle goes to the chosen tool.
    const head = f.size > TRIAGE_READ_LIMIT ? f.slice(0, TRIAGE_READ_LIMIT) : f;
    file = { bytes: new Uint8Array(await head.arrayBuffer()), name: f.name, handle: f };
    ta.value = '';
    update();
  }

  function update() {
    clear(results);
    let sample: Sample;
    if (file) {
      const textual = isValidUtf8(file.bytes) && printableRatio(file.bytes) > 0.9;
      sample = sampleFrom(textual ? utf8Decode(file.bytes) : null, file.bytes, file.name);
      results.append(
        h(
          'p',
          { class: 'triage-file' },
          t('ui.home.fileInfo', { name: file.name, count: file.handle.size }),
        ),
      );
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
          h('span', { class: 'flag-strip-label' }, t('ui.home.alreadyFlag')),
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
      results.append(h('p', { class: 'empty' }, t('ui.home.noGuess')));
      return;
    }
    results.append(
      h('h2', { class: 'triage-h' }, t('ui.home.looksLike')),
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
                    file
                      ? file.handle.size > TRIAGE_READ_LIMIT
                        ? { file: file.handle, name: file.name }
                        : { bytes: file.bytes, file: file.handle, name: file.name }
                      : { text: sample.text ?? '' },
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
              h('span', { class: 'guess-name' }, toolName(r.tool)),
              h('span', { class: 'guess-why' }, r.reason ?? toolDescription(r.tool)),
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
        t('ui.input.openFile'),
      ),
      h('span', { class: 'fine' }, t('ui.home.local')),
    ),
    fileInput,
  );

  main.append(
    h(
      'section',
      { class: 'home' },
      h('h1', { class: 'home-title' }, t('ui.home.title')),
      h('p', { class: 'home-lede' }, t('ui.home.lede', { count: TOOLS.length })),
      drop,
      results,
      h(
        'div',
        { class: 'index' },
        ...CATEGORIES.map((cat) => {
          const tools = TOOLS.filter((x) => x.category === cat.id);
          if (!tools.length) return null;
          return h(
            'section',
            { class: 'index-cat' },
            h(
              'h2',
              null,
              h('span', { class: `glyph glyph-${cat.id}`, 'aria-hidden': 'true' }),
              categoryName(cat.id),
            ),
            h('p', { class: 'index-blurb' }, categoryBlurb(cat.id)),
            h(
              'ul',
              null,
              ...tools.map((tool) =>
                h(
                  'li',
                  null,
                  h(
                    'a',
                    { href: `#/tool/${tool.id}` },
                    h('span', null, toolName(tool)),
                    h('small', null, toolDescription(tool)),
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
