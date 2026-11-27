/**
 * The gallery block: collapsible groups of pictures, a "look first" strip at the top, thumbnails
 * drawn lazily (only when they scroll into view) and a full-screen viewer with zoom, pan, a
 * pixel inspector, per-image and all-images downloads. Keyboard: arrows move between pictures,
 * + / - / 0 zoom, Esc closes.
 */
import type { GalleryItem, Output, RgbaImage } from '../core/types';
import { t } from '../i18n';
import { downloadBytes, h } from './dom';
import {
  fillView,
  fitView,
  imageToPng,
  itemFileName,
  pixelUnder,
  readPixel,
  stepIndex,
  zipItems,
  zoomAt,
  type View,
} from './gallery-core';
import { imageCanvas, type OutputContext } from './outputs';

type GalleryOutput = Extract<Output, { type: 'gallery' }>;

/** Longest side of a thumbnail canvas, in pixels (drawn twice the CSS size for sharp screens). */
const THUMB_SIDE = 200;
const ZOOM_STEP = 1.25;

/** Copy of a picture's pixels scaled to fit `side` (nearest neighbour, so bit planes stay crisp). */
function thumbCanvas(img: RgbaImage): HTMLCanvasElement {
  const full = imageCanvas(img);
  const k = Math.min(1, THUMB_SIDE / Math.max(img.width, img.height));
  const small = h('canvas', {
    class: 'gallery-thumb-canvas',
    width: Math.max(1, Math.round(img.width * k)),
    height: Math.max(1, Math.round(img.height * k)),
  });
  const c2d = small.getContext('2d');
  if (c2d) {
    c2d.imageSmoothingEnabled = false;
    c2d.drawImage(full, 0, 0, small.width, small.height);
  }
  return small;
}

/** Calls `draw` for an element when it first comes near the viewport (at once without the API). */
function whenVisible(el: Element, draw: () => void): void {
  if (typeof IntersectionObserver === 'undefined') {
    draw();
    return;
  }
  const seen = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      seen.disconnect();
      draw();
    },
    { rootMargin: '200px' },
  );
  seen.observe(el);
}

function thumb(item: GalleryItem, open: () => void): HTMLButtonElement {
  const box = h('span', { class: 'gallery-thumb-box' });
  whenVisible(box, () => box.append(thumbCanvas(item.image)));
  return h(
    'button',
    {
      type: 'button',
      class: `gallery-item${item.suspect ? ' is-suspect' : ''}`,
      'data-id': item.id,
      title: item.note ?? item.label,
      onclick: open,
    },
    box,
    h('span', { class: 'gallery-caption' }, item.label),
  );
}

/** The full-screen viewer, built once per gallery and reused for every picture. */
function viewer(items: GalleryItem[]) {
  let index = 0;
  let view: View = { scale: 1, x: 0, y: 0 };
  let fitted = true;
  let canvas: HTMLCanvasElement | null = null;

  const title = h('span', { class: 'gv-title' });
  const position = h('span', { class: 'gv-pos' });
  const note = h('p', { class: 'gv-note' });
  const readout = h('div', { class: 'gv-readout', 'aria-live': 'off' });
  const stage = h('div', { class: 'gv-stage', tabindex: 0 });
  const zoomText = h('span', { class: 'gv-zoom' });

  const apply = () => {
    if (!canvas) return;
    canvas.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    zoomText.textContent = `${Math.round(view.scale * 100)}%`;
  };
  const size = () => ({ w: stage.clientWidth, h: stage.clientHeight });
  const current = () => items[index]!;
  const fit = () => {
    const { w, h: ht } = size();
    view = fitView(w, ht, current().image.width, current().image.height);
    fitted = true;
    apply();
  };
  const fill = () => {
    const { w, h: ht } = size();
    view = fillView(w, ht, current().image.width, current().image.height);
    fitted = false;
    apply();
  };
  const zoom = (factor: number, cx?: number, cy?: number) => {
    const { w, h: ht } = size();
    view = zoomAt(view, factor, cx ?? w / 2, cy ?? ht / 2);
    fitted = false;
    apply();
  };
  const actual = () => {
    const { w, h: ht } = size();
    view = zoomAt(view, 1 / view.scale, w / 2, ht / 2);
    fitted = false;
    apply();
  };

  const show = (i: number) => {
    index = stepIndex(i, 0, items.length);
    const item = current();
    canvas = imageCanvas(item.image);
    canvas.className = 'gv-canvas';
    canvas.removeAttribute('title');
    stage.replaceChildren(canvas);
    title.textContent = item.label;
    position.textContent = `${index + 1} / ${items.length}`;
    note.textContent = item.note ?? '';
    note.hidden = !item.note;
    readout.textContent = t('ui.gallery.hover');
    fit();
  };

  const inspect = (ev: PointerEvent) => {
    const rect = stage.getBoundingClientRect();
    const at = pixelUnder(
      view,
      ev.clientX - rect.left,
      ev.clientY - rect.top,
      current().image.width,
      current().image.height,
    );
    const p = at && readPixel(current().image, at.x, at.y);
    if (!p) {
      readout.textContent = t('ui.gallery.hover');
      return;
    }
    readout.replaceChildren(
      h('span', null, t('ui.gallery.position', { x: p.x, y: p.y })),
      h('span', null, `RGBA ${p.rgba.join(', ')} · ${p.hex}`),
      ...(['R', 'G', 'B', 'A'] as const).map((name, c) =>
        h('span', { class: 'gv-bits' }, `${name} ${p.bits[c]}`),
      ),
    );
  };

  // Drag to pan, wheel to zoom at the pointer.
  let drag: { id: number; x: number; y: number } | null = null;
  stage.addEventListener('pointerdown', (ev) => {
    drag = { id: ev.pointerId, x: ev.clientX, y: ev.clientY };
    stage.setPointerCapture(ev.pointerId);
    stage.classList.add('is-dragging');
  });
  stage.addEventListener('pointermove', (ev) => {
    if (drag && drag.id === ev.pointerId) {
      view = { ...view, x: view.x + ev.clientX - drag.x, y: view.y + ev.clientY - drag.y };
      drag = { id: ev.pointerId, x: ev.clientX, y: ev.clientY };
      fitted = false;
      apply();
    }
    inspect(ev);
  });
  const release = (ev: PointerEvent) => {
    if (drag?.id === ev.pointerId) drag = null;
    stage.classList.remove('is-dragging');
  };
  stage.addEventListener('pointerup', release);
  stage.addEventListener('pointercancel', release);
  stage.addEventListener(
    'wheel',
    (ev) => {
      ev.preventDefault();
      const rect = stage.getBoundingClientRect();
      zoom(
        ev.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP,
        ev.clientX - rect.left,
        ev.clientY - rect.top,
      );
    },
    { passive: false },
  );

  const button = (label: string, onclick: () => void, cls = 'btn-ghost') =>
    h('button', { type: 'button', class: `btn ${cls}`, onclick }, label);
  const dialog = h(
    'dialog',
    { class: 'gallery-viewer', 'aria-label': t('ui.gallery.viewer') },
    h(
      'div',
      { class: 'gv-bar' },
      h('div', { class: 'gv-head' }, title, position),
      h(
        'div',
        { class: 'gv-tools' },
        button(t('ui.gallery.prev'), () => show(index - 1)),
        button(t('ui.gallery.next'), () => show(index + 1)),
        button('−', () => zoom(1 / ZOOM_STEP)),
        zoomText,
        button('+', () => zoom(ZOOM_STEP)),
        button(t('ui.gallery.fit'), fit),
        button('1:1', actual),
        button(t('ui.gallery.fill'), fill),
        button(t('ui.out.downloadPng'), () =>
          downloadBytes(imageToPng(current().image), itemFileName(current())),
        ),
        button(t('ui.gallery.close'), () => dialog.close()),
      ),
    ),
    note,
    stage,
    readout,
  );
  dialog.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') show(index + 1);
    else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') show(index - 1);
    else if (ev.key === '+' || ev.key === '=') zoom(ZOOM_STEP);
    else if (ev.key === '-') zoom(1 / ZOOM_STEP);
    else if (ev.key === '0') fit();
    else return;
    ev.preventDefault();
  });
  window.addEventListener('resize', () => {
    if (dialog.open && fitted) fit();
  });
  // Clicking the backdrop (the dialog itself, outside its content) closes it.
  dialog.addEventListener('click', (ev) => {
    if (ev.target === dialog) dialog.close();
  });
  return {
    dialog,
    open(i: number) {
      if (!dialog.isConnected) document.body.append(dialog);
      if (!dialog.open) dialog.showModal();
      show(i);
    },
  };
}

export function renderGallery(o: GalleryOutput, _ctx: OutputContext): HTMLElement {
  const items = o.groups.flatMap((g) => g.items);
  const byId = new Map(items.map((i, n) => [i.id, n]));
  let box: ReturnType<typeof viewer> | null = null;
  const openAt = (id: string) => {
    box ??= viewer(items);
    box.open(byId.get(id) ?? 0);
  };

  const all = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-ghost',
      onclick: () => {
        all.disabled = true;
        all.textContent = t('ui.gallery.preparing');
        // Let the label paint before the encoding blocks the thread.
        setTimeout(() => {
          downloadBytes(zipItems(items), 'image-lab.zip');
          all.disabled = false;
          all.textContent = t('ui.gallery.downloadAll');
        }, 30);
      },
    },
    t('ui.gallery.downloadAll'),
  );

  const first = (o.lookFirst ?? [])
    .map((id) => items[byId.get(id) ?? -1])
    .filter((i): i is GalleryItem => i !== undefined);

  return h(
    'section',
    { class: 'out out-gallery' },
    h(
      'div',
      { class: 'out-head' },
      h('span', { class: 'out-label' }, o.label ?? t('ui.gallery.title')),
      h('span', { class: 'out-meta' }, t('ui.gallery.count', { count: items.length })),
      h('span', { class: 'out-actions' }, all),
    ),
    first.length
      ? h(
          'div',
          { class: 'gallery-look', role: 'region', 'aria-label': t('ui.gallery.lookFirst') },
          h('h3', { class: 'gallery-look-title' }, t('ui.gallery.lookFirst')),
          h('div', { class: 'gallery-grid' }, ...first.map((i) => thumb(i, () => openAt(i.id)))),
        )
      : null,
    ...o.groups.map((g, n) =>
      h(
        'details',
        { class: 'gallery-group', open: n === 0 },
        h(
          'summary',
          { class: 'gallery-summary' },
          g.title,
          h('span', { class: 'gallery-n' }, ` ${g.items.length}`),
        ),
        h('div', { class: 'gallery-grid' }, ...g.items.map((i) => thumb(i, () => openAt(i.id)))),
      ),
    ),
  );
}
