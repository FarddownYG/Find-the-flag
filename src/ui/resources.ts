/**
 * The Resources directory: a filterable list of external CTF links (data in src/resources/data.ts).
 * These are links, not tools that run here — every link opens in a new tab. Built with the same
 * `h()` text-node builder and design tokens as the rest of the app; no markup is ever injected.
 */
import { t } from '../i18n';
import {
  RESOURCE_CATEGORIES,
  RESOURCE_KINDS,
  RESOURCE_SOURCE,
  RESOURCE_SOURCE_URL,
  RESOURCES,
  type Resource,
  type ResourceCategory,
  type ResourceKind,
} from '../resources/data';
import { clear, debounce, h } from './dom';

const catLabel = (c: ResourceCategory): string => t(`ui.resources.cat.${c}`);
const kindLabel = (k: ResourceKind): string => t(`ui.resources.kind.${k}`);

function matches(r: Resource, cat: string, kind: string, query: string): boolean {
  if (cat && r.category !== cat) return false;
  if (kind && r.kind !== kind) return false;
  if (query) {
    const q = query.toLowerCase();
    if (!r.name.toLowerCase().includes(q) && !r.description.toLowerCase().includes(q)) return false;
  }
  return true;
}

function entryCard(r: Resource): HTMLElement {
  return h(
    'li',
    { class: 'res-card' },
    h(
      'a',
      { class: 'res-link', href: r.url, target: '_blank', rel: 'noopener noreferrer' },
      h('span', { class: 'res-name' }, r.name),
      h('span', { class: `res-kind res-kind-${r.kind}` }, kindLabel(r.kind)),
    ),
    h('p', { class: 'res-desc' }, r.description),
  );
}

export function renderResources(main: HTMLElement): void {
  let cat = '';
  let kind = '';
  let query = '';

  const results = h('div', { class: 'res-results', 'aria-live': 'polite' });
  const count = h('p', { class: 'res-count', 'aria-live': 'polite' });

  function renderList() {
    clear(results);
    clear(count);
    const shown = RESOURCES.filter((r) => matches(r, cat, kind, query));
    count.append(t('ui.resources.count', { shown: shown.length, total: RESOURCES.length }));
    if (!shown.length) {
      results.append(h('p', { class: 'empty' }, t('ui.resources.empty')));
      return;
    }
    for (const c of RESOURCE_CATEGORIES) {
      const group = shown.filter((r) => r.category === c);
      if (!group.length) continue;
      const section = h(
        'section',
        { class: 'res-cat' },
        h(
          'h2',
          null,
          h('span', null, catLabel(c)),
          h('span', { class: 'res-cat-n' }, String(group.length)),
        ),
      );
      if (c === 'reversing') {
        section.append(h('p', { class: 'res-note' }, t('ui.resources.reversingNote')));
      }
      section.append(h('ul', { class: 'res-grid' }, ...group.map(entryCard)));
      results.append(section);
    }
  }

  const catSelect = h(
    'select',
    {
      class: 'res-filter',
      'aria-label': t('ui.resources.filterCategory'),
      onchange: () => {
        cat = catSelect.value;
        renderList();
      },
    },
    h('option', { value: '' }, t('ui.resources.allCategories')),
    ...RESOURCE_CATEGORIES.map((c) => h('option', { value: c }, catLabel(c))),
  );

  const kindSelect = h(
    'select',
    {
      class: 'res-filter',
      'aria-label': t('ui.resources.filterKind'),
      onchange: () => {
        kind = kindSelect.value;
        renderList();
      },
    },
    h('option', { value: '' }, t('ui.resources.allKinds')),
    ...RESOURCE_KINDS.map((k) => h('option', { value: k }, kindLabel(k))),
  );

  const searchInput = h('input', {
    type: 'search',
    class: 'res-search',
    placeholder: t('ui.resources.search'),
    'aria-label': t('ui.resources.search'),
    autocomplete: 'off',
    spellcheck: false,
    oninput: debounce(() => {
      query = searchInput.value.trim();
      renderList();
    }, 120),
  });

  renderList();

  main.append(
    h(
      'section',
      { class: 'resources' },
      h('h1', { class: 'res-title' }, t('ui.resources.title')),
      h('p', { class: 'res-lede' }, t('ui.resources.lede', { count: RESOURCES.length })),
      h('p', { class: 'res-attribution' }, [
        t('ui.resources.attribution'),
        ' ',
        h(
          'a',
          {
            class: 'res-src',
            href: RESOURCE_SOURCE_URL,
            target: '_blank',
            rel: 'noopener noreferrer',
          },
          RESOURCE_SOURCE,
        ),
      ]),
      h(
        'div',
        { class: 'res-controls' },
        h(
          'label',
          { class: 'res-control' },
          h('span', null, t('ui.resources.filterCategory')),
          catSelect,
        ),
        h(
          'label',
          { class: 'res-control' },
          h('span', null, t('ui.resources.filterKind')),
          kindSelect,
        ),
        h(
          'label',
          { class: 'res-control res-control-search' },
          h('span', null, t('ui.resources.search')),
          searchInput,
        ),
      ),
      count,
      results,
      h('p', { class: 'res-foot fine' }, t('ui.resources.externalNote')),
    ),
  );
}
