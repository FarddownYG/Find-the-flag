import { encode as encodePng } from 'fast-png';
import { findFlags } from '../core/flags';
import type { RawInput } from '../core/prepare';
import { TOOLS } from '../core/registry';
import type { Category, Output, RgbaImage, ToolResult } from '../core/types';
import { formatSize, isValidUtf8, printableRatio, utf8Decode } from '../lib/bytes';
import { clear, copyText, downloadBytes, h, type Child } from './dom';
import { t } from '../i18n';
import { categoryName, toolName } from '../i18n/tool-text';
import { flagSettings } from './settings';
import { mapBlock } from './map';

export interface OutputContext {
  /** Open another tool with this data as its input. */
  pipe: (toolId: string, raw: RawInput) => void;
  /** Flag candidates worth highlighting in this result (see selectFlags). */
  highlight: Set<string>;
}

const TEXT_LIMIT = 200_000;
const ROW_LIMIT = 500;

/** Text with flag candidates wrapped in <mark>. */
export function flagged(text: string, ctx?: OutputContext): Child[] {
  const spans = findFlags(text, flagSettings.regex).filter(
    (s) => !ctx || ctx.highlight.has(s.value),
  );
  if (!spans.length) return [text];
  const out: Child[] = [];
  let at = 0;
  for (const s of spans) {
    out.push(text.slice(at, s.start), h('mark', { class: 'flag-mark' }, s.value));
    at = s.end;
  }
  out.push(text.slice(at));
  return out;
}

function pipeSelect(raw: () => RawInput, ctx: OutputContext): HTMLSelectElement {
  const sel = h(
    'select',
    {
      class: 'pipe',
      'aria-label': t('ui.out.sendToLabel'),
      onchange: () => {
        if (sel.value) ctx.pipe(sel.value, raw());
        sel.value = '';
      },
    },
    h('option', { value: '' }, t('ui.out.sendTo')),
    ...groupTools().map(([cat, tools]) =>
      h(
        'optgroup',
        { label: categoryName(cat) },
        ...tools.map((x) => h('option', { value: x.id }, toolName(x))),
      ),
    ),
  );
  return sel;
}

function groupTools() {
  const groups = new Map<Category, (typeof TOOLS)[number][]>();
  for (const tool of TOOLS) {
    if (tool.input === 'audio') continue;
    const list = groups.get(tool.category) ?? [];
    list.push(tool);
    groups.set(tool.category, list);
  }
  return [...groups.entries()];
}

function header(label: string | undefined, meta: Child, actions: Child[]): HTMLElement {
  return h(
    'div',
    { class: 'out-head' },
    h('span', { class: 'out-label' }, label ?? t('ui.tool.output')),
    meta ? h('span', { class: 'out-meta' }, meta) : null,
    h('span', { class: 'out-actions' }, ...actions),
  );
}

function button(
  label: string,
  onclick: (ev: MouseEvent) => void,
  cls = 'btn-ghost',
): HTMLButtonElement {
  return h('button', { type: 'button', class: `btn ${cls}`, onclick }, label);
}

function textBlock(o: Extract<Output, { type: 'text' }>, ctx: OutputContext): HTMLElement {
  const pre = h('pre', { class: 'out-pre' });
  const fill = (all: boolean) => {
    clear(pre);
    const shown = all ? o.value : o.value.slice(0, TEXT_LIMIT);
    pre.append(...(flagged(shown, ctx) as (string | Node)[]));
    if (!all && o.value.length > TEXT_LIMIT) {
      pre.append(
        h(
          'button',
          { type: 'button', class: 'btn btn-ghost more', onclick: () => fill(true) },
          t('ui.out.showAllChars', { count: o.value.length }),
        ),
      );
    }
  };
  fill(false);
  const copy: HTMLButtonElement = button(t('ui.out.copy'), () => copyText(o.value, copy));
  return h(
    'section',
    { class: 'out out-text' },
    header(o.label, t('ui.input.chars', { count: o.value.length }), [
      copy,
      pipeSelect(() => ({ text: o.value }), ctx),
    ]),
    pre,
  );
}

const HEXB = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

export function hexView(bytes: Uint8Array, rowsPerPage = 64): HTMLElement {
  const width = 16;
  const pageSize = rowsPerPage * width;
  const pages = Math.max(1, Math.ceil(bytes.length / pageSize));
  let page = 0;
  const pre = h('pre', { class: 'hex' });
  const pos = h('span', { class: 'hex-pos' });
  const render = () => {
    clear(pre);
    const start = page * pageSize;
    const end = Math.min(bytes.length, start + pageSize);
    const offW = Math.max(8, bytes.length.toString(16).length);
    for (let row = start; row < end; row += width) {
      const hexParts: string[] = [];
      let ascii = '';
      for (let i = 0; i < width; i++) {
        const b = bytes[row + i];
        if (b === undefined) {
          hexParts.push('  ');
          continue;
        }
        hexParts.push(HEXB[b]!);
        ascii += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '·';
      }
      const hex = hexParts.slice(0, 8).join(' ') + '  ' + hexParts.slice(8).join(' ');
      pre.append(
        h('span', { class: 'hex-off' }, row.toString(16).padStart(offW, '0')),
        '  ',
        hex,
        '  ',
        h('span', { class: 'hex-ascii' }, ascii),
        '\n',
      );
    }
    pos.textContent = pages > 1 ? t('ui.hex.page', { page: page + 1, pages }) : '';
  };
  render();
  const nav =
    pages > 1
      ? h(
          'div',
          { class: 'hex-nav' },
          button(t('ui.hex.prev'), () => {
            page = Math.max(0, page - 1);
            render();
          }),
          pos,
          button(t('ui.hex.next'), () => {
            page = Math.min(pages - 1, page + 1);
            render();
          }),
          h('input', {
            type: 'text',
            class: 'hex-goto',
            placeholder: 'go to 0x…',
            'aria-label': t('ui.hex.gotoLabel'),
            onkeydown: (ev: KeyboardEvent) => {
              if (ev.key !== 'Enter') return;
              const v = (ev.target as HTMLInputElement).value.trim();
              const off = v.startsWith('0x') ? parseInt(v, 16) : parseInt(v, 10);
              if (Number.isFinite(off)) {
                page = Math.min(pages - 1, Math.max(0, Math.floor(off / pageSize)));
                render();
              }
            },
          }),
        )
      : null;
  return h('div', { class: 'hex-wrap' }, nav, pre);
}

function bytesBlock(o: Extract<Output, { type: 'bytes' }>, ctx: OutputContext): HTMLElement {
  const textual = isValidUtf8(o.value) && printableRatio(o.value) > 0.85;
  const body = h('div', { class: 'out-body' });
  let mode: 'text' | 'hex' = textual ? 'text' : 'hex';
  const tabs = h('span', { class: 'seg seg-sm', role: 'group', 'aria-label': 'View as' });
  const show = () => {
    clear(body);
    if (mode === 'text') {
      const s = utf8Decode(o.value.subarray(0, TEXT_LIMIT));
      body.append(h('pre', { class: 'out-pre' }, ...(flagged(s, ctx) as Child[])));
    } else body.append(hexView(o.value));
    for (const b of tabs.querySelectorAll('button'))
      b.setAttribute('aria-pressed', String(b.dataset.v === mode));
  };
  for (const v of ['text', 'hex'] as const) {
    tabs.append(
      h(
        'button',
        { type: 'button', 'data-v': v, onclick: () => ((mode = v), show()) },
        v === 'text' ? 'Text' : 'Hex',
      ),
    );
  }
  show();
  const copy: HTMLButtonElement = button(t('ui.out.copy'), () =>
    copyText(utf8Decode(o.value), copy),
  );
  return h(
    'section',
    { class: 'out out-bytes' },
    header(o.label, formatSize(o.value.length), [
      tabs,
      copy,
      button(t('ui.out.download'), () => downloadBytes(o.value, o.filename ?? 'output.bin')),
      pipeSelect(() => ({ bytes: o.value, name: o.filename }), ctx),
    ]),
    body,
  );
}

/** Long tables and lists get a filter box (metadata dumps, strings, packet lists...). */
const FILTER_MIN_ROWS = 12;

function filterBox(onInput: (q: string) => void): HTMLInputElement {
  return h('input', {
    type: 'search',
    class: 'out-filter',
    placeholder: t('ui.out.filter'),
    'aria-label': t('ui.out.filterLabel'),
    spellcheck: false,
    oninput: (e: Event) => onInput((e.target as HTMLInputElement).value.trim().toLowerCase()),
  });
}

function tableBlock(o: Extract<Output, { type: 'table' }>, ctx: OutputContext): HTMLElement {
  const tbody = h('tbody');
  const hl = new Set(o.highlight ?? []);
  const meta = h('span', null, `${o.rows.length} rows`);
  let query = '';
  const fill = (n: number) => {
    clear(tbody);
    const rows = o.rows
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => !query || r.some((c) => String(c).toLowerCase().includes(query)));
    meta.textContent = query
      ? t('ui.out.rowsOf', { shown: rows.length, count: o.rows.length })
      : t('ui.out.rows', { count: o.rows.length });
    for (const { r, i } of rows.slice(0, n)) {
      tbody.append(
        h(
          'tr',
          { class: hl.has(i) ? 'is-hl' : undefined },
          ...r.map((c) => h('td', null, ...flagged(String(c), ctx))),
        ),
      );
    }
    if (rows.length > n) {
      tbody.append(
        h(
          'tr',
          null,
          h(
            'td',
            { colspan: o.columns.length },
            button(t('ui.out.showAllRows', { count: rows.length }), () => fill(rows.length)),
          ),
        ),
      );
    }
  };
  fill(ROW_LIMIT);
  const tsv = () => [o.columns, ...o.rows].map((r) => r.join('\t')).join('\n');
  const copy: HTMLButtonElement = button(t('ui.out.copyTsv'), () => copyText(tsv(), copy));
  const filter =
    o.rows.length >= FILTER_MIN_ROWS
      ? filterBox((q) => {
          query = q;
          fill(ROW_LIMIT);
        })
      : null;
  return h(
    'section',
    { class: 'out out-table' },
    header(o.label, meta, [filter, copy]),
    h(
      'div',
      { class: 'table-scroll' },
      h(
        'table',
        null,
        h('thead', null, h('tr', null, ...o.columns.map((c) => h('th', null, c)))),
        tbody,
      ),
    ),
  );
}

function kvBlock(o: Extract<Output, { type: 'kv' }>, ctx: OutputContext): HTMLElement {
  const copy: HTMLButtonElement = button(t('ui.out.copy'), () =>
    copyText(o.entries.map(([k, v]) => `${k}: ${v}`).join('\n'), copy),
  );
  const dl = h('dl', { class: 'kv' });
  const fill = (q: string) => {
    clear(dl);
    for (const [k, v] of o.entries) {
      if (q && !`${k} ${v}`.toLowerCase().includes(q)) continue;
      dl.append(
        h('dt', null, k, h('span', { class: 'visually-hidden' }, ': ')),
        h('dd', null, ...flagged(v, ctx)),
      );
    }
  };
  fill('');
  const filter = o.entries.length >= FILTER_MIN_ROWS ? filterBox(fill) : null;
  return h('section', { class: 'out out-kv' }, header(o.label, null, [filter, copy]), dl);
}

export function imageCanvas(img: RgbaImage): HTMLCanvasElement {
  const canvas = h('canvas', { class: 'out-canvas', width: img.width, height: img.height });
  const c2d = canvas.getContext('2d');
  if (c2d)
    c2d.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  canvas.title = t('ui.out.zoomHint');
  canvas.addEventListener('click', () => canvas.classList.toggle('is-actual'));
  return canvas;
}

function imageBlock(o: Extract<Output, { type: 'image' }>, ctx: OutputContext): HTMLElement {
  const canvas = imageCanvas(o.image);
  // Piping an image (e.g. a bit plane hiding a QR code) sends it as a lossless PNG.
  const asPng = (): RawInput => ({
    bytes: encodePng({
      width: o.image.width,
      height: o.image.height,
      data: o.image.data,
      channels: 4,
      depth: 8,
    }),
    name: o.filename ?? 'image.png',
  });
  return h(
    'section',
    { class: 'out out-image' },
    header(o.label, `${o.image.width}×${o.image.height}`, [
      button(t('ui.out.downloadPng'), () =>
        canvas.toBlob((b) => b && downloadBytes(b, o.filename ?? 'image.png'), 'image/png'),
      ),
      pipeSelect(asPng, ctx),
    ]),
    h('div', { class: 'canvas-frame' }, canvas),
  );
}

function filesBlock(o: Extract<Output, { type: 'files' }>, ctx: OutputContext): HTMLElement {
  return h(
    'section',
    { class: 'out out-files' },
    header(o.label ?? t('ui.out.files'), t('ui.out.fileCount', { count: o.files.length }), []),
    h(
      'ul',
      { class: 'files' },
      ...o.files.map((f) =>
        h(
          'li',
          null,
          h('span', { class: 'file-name' }, f.name),
          h(
            'span',
            { class: 'file-meta' },
            formatSize(f.data.length),
            f.note ? ` · ${f.note}` : '',
          ),
          h(
            'span',
            { class: 'out-actions' },
            button(t('ui.out.download'), () =>
              downloadBytes(f.data, f.name.split('/').pop() || 'file.bin'),
            ),
            pipeSelect(() => ({ bytes: f.data, name: f.name }), ctx),
          ),
        ),
      ),
    ),
  );
}

function pictureBlock(o: Extract<Output, { type: 'picture' }>, ctx: OutputContext): HTMLElement {
  const url = URL.createObjectURL(new Blob([o.data as BlobPart], { type: o.mime }));
  const img = h('img', { class: 'out-picture', src: url, alt: o.label ?? 'Embedded image' });
  const name = o.filename ?? `image.${o.mime.split('/')[1] ?? 'bin'}`;
  return h(
    'section',
    { class: 'out out-image' },
    header(o.label ?? t('ui.out.picture'), `${o.mime} · ${formatSize(o.data.length)}`, [
      button(t('ui.out.download'), () => downloadBytes(o.data, name)),
      pipeSelect(() => ({ bytes: o.data, name }), ctx),
    ]),
    h('div', { class: 'canvas-frame' }, img),
  );
}

function noteBlock(o: Extract<Output, { type: 'note' }>, ctx: OutputContext): HTMLElement {
  return h(
    'p',
    { class: `note note-${o.level}`, role: o.level === 'error' ? 'alert' : undefined },
    ...flagged(o.text, ctx),
  );
}

export function renderResult(result: ToolResult, ctx: OutputContext): HTMLElement[] {
  return result.map((o) => {
    switch (o.type) {
      case 'text':
        return textBlock(o, ctx);
      case 'bytes':
        return bytesBlock(o, ctx);
      case 'table':
        return tableBlock(o, ctx);
      case 'kv':
        return kvBlock(o, ctx);
      case 'image':
        return imageBlock(o, ctx);
      case 'files':
        return filesBlock(o, ctx);
      case 'note':
        return noteBlock(o, ctx);
      case 'picture':
        return pictureBlock(o, ctx);
      case 'map':
        return mapBlock(o);
    }
  });
}
