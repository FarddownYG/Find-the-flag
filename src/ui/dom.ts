import { t } from '../i18n';

/** Tiny DOM builder. Strings always become text nodes: untrusted tool data can never inject HTML. */
export type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, unknown> & { class?: string };

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k in el && typeof v !== 'string') {
      (el as unknown as Record<string, unknown>)[k] = v;
    } else if (k === 'value' || k === 'checked') {
      (el as unknown as Record<string, unknown>)[k] = v;
    } else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

export function append(parent: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(parent, c);
    else
      parent.appendChild(
        typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c,
      );
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function downloadBytes(data: Uint8Array | Blob, filename: string): void {
  const blob =
    data instanceof Blob
      ? data
      : new Blob([data as BlobPart], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copyText(text: string, button?: HTMLElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    if (button) flash(button, t('ui.out.copied'));
  } catch {
    if (button) flash(button, t('ui.out.copyBlocked'));
  }
}

function flash(button: HTMLElement, msg: string) {
  const prev = button.textContent;
  button.textContent = msg;
  button.classList.add('is-flashed');
  setTimeout(() => {
    button.textContent = prev;
    button.classList.remove('is-flashed');
  }, 1200);
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...a: A) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}
