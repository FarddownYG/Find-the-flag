import { selectFlags } from '../core/flags';
import { resultToText } from '../core/result-text';
import { CancelledError, Runner } from '../core/runner';
import { getTool, TOOLS } from '../core/registry';
import { CATEGORIES, type AnyTool, type Sample } from '../core/types';
import { getLocale, LOCALES, isLocale, onLocaleChange, setLocale, t } from '../i18n';
import { categoryBlurb, categoryName, toolDescription, toolName } from '../i18n/tool-text';
import { formatSize, isValidUtf8, printableRatio, utf8Decode, utf8Encode } from '../lib/bytes';
import { clear, copyText, debounce, h } from './dom';
import { renderAnalysis } from './analysis-view';
import type { AnalysisSource } from './analysis-lessons';
import { renderResources } from './resources';
import { search } from './search';
import { flagSettings } from './settings';
import { renderTool, setPending } from './tool-view';
import { holdFile } from './unload-guard';

export function mountApp(root: HTMLElement): void {
  const main = h('main', { class: 'main', id: 'main', tabindex: '-1' });
  let nav = h('nav');
  let searchBox = h('input');
  let menuBtn = h('button');
  let resLink = h('a');
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
    resLink = h(
      'a',
      {
        class: 'side-link',
        href: '#/resources',
        'aria-current': current === 'resources' ? 'page' : undefined,
      },
      t('ui.resources.navLink'),
    );
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
      resLink,
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
    // Best match first within each category (the registry order when nothing is typed).
    const results = search(searchBox.value);
    for (const cat of CATEGORIES) {
      const tools = results.filter((x) => x.category === cat.id);
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
    if (!results.length) nav.append(h('p', { class: 'nav-empty' }, t('ui.search.none')));
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
    const onResources = /^#\/resources\b/.test(location.hash);
    current = tool?.id ?? (onResources ? 'resources' : '');
    if (onResources) resLink.setAttribute('aria-current', 'page');
    else resLink.removeAttribute('aria-current');
    if (tool) {
      document.title = `${toolName(tool)} · Find The Flag`;
      teardown = renderTool(tool, main, (id) => (location.hash = `#/tool/${id}`));
    } else if (onResources) {
      document.title = `${t('ui.resources.title')} · Find The Flag`;
      renderResources(main);
    } else {
      document.title = t('ui.title');
      teardown = renderHome(main);
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
/** The analysis reads at most this much of a file; the rest is left out and said so. */
const ANALYZE_READ_LIMIT = 64 * 1024 * 1024;
/** Pasted text shorter than this is not worth an analysis. */
const ANALYZE_MIN_TEXT = 8;

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

function renderHome(main: HTMLElement): () => void {
  const guard = Symbol('home-file');
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
      holdFile(guard, false);
      update();
    }, 120),
  });

  // The automatic analysis: the `analyze` tool in a worker of its own, stoppable, shown above the guesses.
  const analysis = h('div', { class: 'analysis-slot', 'aria-live': 'polite' });
  const runner = new Runner();
  let runToken = 0;
  let stoppedToken = 0;

  function stopAnalysis() {
    runToken++;
    runner.cancel();
    clear(analysis);
  }

  /** What to analyse right now, or null when there is nothing (or too little) on screen. */
  function currentJob(): {
    name?: string;
    load: () => Promise<AnalysisSource>;
    cut: number;
  } | null {
    if (file) {
      const f = file;
      return {
        name: f.name,
        cut: f.handle.size > ANALYZE_READ_LIMIT ? ANALYZE_READ_LIMIT : 0,
        load: async () => {
          const bytes =
            f.handle.size <= TRIAGE_READ_LIMIT
              ? f.bytes
              : new Uint8Array(await f.handle.slice(0, ANALYZE_READ_LIMIT).arrayBuffer());
          const big = f.handle.size > TRIAGE_READ_LIMIT;
          return {
            bytes,
            name: f.name,
            raw: big
              ? { file: f.handle, name: f.name }
              : { bytes: f.bytes, file: f.handle, name: f.name },
          };
        },
      };
    }
    // Gate on the trimmed length, but analyse the RAW text: boundary special spaces (U+2000…,
    // U+202F) carry Holloway bits, and trimming would drop them before the decoders run.
    if (ta.value.trim().length < ANALYZE_MIN_TEXT) return null;
    const raw = ta.value.replace(/\n$/, '');
    return {
      cut: 0,
      load: () => {
        const bytes = utf8Encode(raw);
        return Promise.resolve({ bytes, raw: { text: raw } });
      },
    };
  }

  const queueAnalysis = debounce(() => void runAnalysis(), 250);

  async function runAnalysis() {
    const job = currentJob();
    if (!job) return;
    const token = ++runToken;
    clear(analysis);
    analysis.append(
      h(
        'div',
        { class: 'an-busy', role: 'status' },
        h('span', null, t('ui.analysis.running')),
        h(
          'button',
          {
            type: 'button',
            class: 'btn',
            onclick: () => {
              stoppedToken = token;
              runner.cancel();
            },
          },
          t('ui.analysis.stop'),
        ),
      ),
    );
    try {
      const source = await job.load();
      if (token !== runToken) return;
      const result = await runner.run('analyze', { bytes: source.bytes, name: source.name }, {});
      if (token !== runToken) return;
      const found = result.find((o) => o.type === 'analysis');
      clear(analysis);
      if (!found || found.type !== 'analysis') return;
      if (job.cut) {
        analysis.append(
          h(
            'p',
            { class: 'note note-warn' },
            t('ui.analysis.truncated', { size: formatSize(job.cut) }),
          ),
        );
      }
      analysis.append(
        renderAnalysis(
          found.result,
          {
            highlight: selectFlags(resultToText(result), flagSettings.regex, flagSettings.pattern),
            pipe: (id, raw, options) => {
              setPending(id, raw, options);
              location.hash = `#/tool/${id}`;
            },
          },
          source,
        ),
      );
    } catch (e) {
      if (token !== runToken) return;
      clear(analysis);
      if (e instanceof CancelledError && stoppedToken === token) {
        analysis.append(
          h(
            'div',
            { class: 'an-busy' },
            h('span', null, t('ui.analysis.stopped')),
            h(
              'button',
              { type: 'button', class: 'btn', onclick: () => void runAnalysis() },
              t('ui.analysis.rerun'),
            ),
          ),
        );
      } else if (!(e instanceof CancelledError)) {
        analysis.append(
          h(
            'p',
            { class: 'note note-error', role: 'alert' },
            t('ui.analysis.failed', { message: e instanceof Error ? e.message : String(e) }),
          ),
        );
      }
    }
  }

  async function takeFile(f: File) {
    // Detectors only need the start of a big file; the full handle goes to the chosen tool.
    const head = f.size > TRIAGE_READ_LIMIT ? f.slice(0, TRIAGE_READ_LIMIT) : f;
    file = { bytes: new Uint8Array(await head.arrayBuffer()), name: f.name, handle: f };
    holdFile(guard, true);
    ta.value = '';
    update();
  }

  function update() {
    clear(results);
    stopAnalysis();
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
      if (!ta.value.trim()) return;
      // The RAW pasted text (only a single trailing newline stripped): the detectors and any piped
      // tool must see the exact string, special spaces and all, not a trimmed copy.
      const raw = ta.value.replace(/\n$/, '');
      sample = sampleFrom(raw, utf8Encode(raw));
    }
    if (currentJob()) queueAnalysis();
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
      h(
        'p',
        { class: 'home-links' },
        h('a', { class: 'side-link', href: '#/resources' }, t('ui.resources.navLink')),
      ),
      drop,
      analysis,
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
  return () => {
    runToken++;
    runner.cancel();
    holdFile(guard, false);
  };
}
