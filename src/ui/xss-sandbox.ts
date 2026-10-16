/**
 * Renders a `sandbox` output block (emitted only by the XSS workshop). It runs the payload in an
 * isolated iframe loaded from a real same-origin URL (public/xss-sandbox.html) with
 * sandbox="allow-scripts" and NO allow-same-origin: the payload executes, but the frame has a null
 * origin (it cannot read this site's cookies or DOM) and its own Content-Security-Policy blocks
 * every network destination, so nothing is ever sent. Attempts are recorded and shown.
 *
 * Nothing runs until the user presses the button.
 */
import type { Output } from '../core/types';
import { t } from '../i18n';
import { clear, h } from './dom';

interface Result {
  ftf?: string;
  executed?: boolean;
  wouldSend?: string[];
  signals?: string[];
}

const HARNESS = `${import.meta.env.BASE_URL}xss-sandbox.html`;
const TIMEOUT_MS = 5000;

export function sandboxBlock(o: Extract<Output, { type: 'sandbox' }>): HTMLElement {
  const payload = o.payload;
  const out = h('div', { class: 'xss-out' });

  const run: HTMLButtonElement = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-run',
      onclick: () => {
        run.disabled = true;
        run.textContent = t('ui.xss.running');
        execute(payload, out, () => {
          run.disabled = false;
          run.textContent = t('ui.xss.run');
        });
      },
    },
    t('ui.xss.run'),
  );

  return h(
    'section',
    { class: 'out out-xss' },
    h(
      'div',
      { class: 'out-head' },
      h('span', { class: 'out-label' }, o.label ?? t('ui.xss.title')),
    ),
    h('pre', { class: 'out-pre' }, payload),
    h('p', { class: 'note note-info' }, t('ui.xss.notice')),
    h('div', { class: 'action-row' }, run),
    out,
  );
}

function execute(payload: string, out: HTMLElement, done: () => void): void {
  clear(out);
  const frame = h('iframe', {
    class: 'xss-frame',
    sandbox: 'allow-scripts',
    src: HARNESS,
    title: t('ui.xss.render'),
  });
  let settled = false;
  const finish = (render: (host: HTMLElement) => void) => {
    if (settled) return;
    settled = true;
    window.removeEventListener('message', onMessage);
    const host = h('div', { class: 'xss-report' });
    render(host);
    out.append(h('div', { class: 'xss-render-label' }, t('ui.xss.render')), frame, host);
    done();
  };
  const onMessage = (ev: MessageEvent<Result>) => {
    if (ev.source !== frame.contentWindow) return;
    const data = ev.data;
    if (data?.ftf === 'xss-sandbox-ready') {
      frame.contentWindow?.postMessage({ ftf: 'xss-sandbox-run', payload }, '*');
    } else if (data?.ftf === 'xss-sandbox-result') {
      finish((host) => renderResult(host, data));
    }
  };
  window.addEventListener('message', onMessage);
  // The frame must be in the document to load; keep it out of view until a result is in.
  out.append(frame);
  setTimeout(() => finish((host) => host.append(note('warn', t('ui.xss.timeout')))), TIMEOUT_MS);
}

function renderResult(host: HTMLElement, data: Result): void {
  host.append(
    data.executed ? note('success', t('ui.xss.executed')) : note('info', t('ui.xss.notExecuted')),
  );
  const attempts = data.wouldSend ?? [];
  if (attempts.length) {
    host.append(
      h('p', { class: 'xss-would-send' }, t('ui.xss.wouldSend')),
      h('ul', { class: 'xss-attempts' }, ...attempts.map((a) => h('li', null, a))),
      note('success', t('ui.xss.nothingSent')),
      note('info', t('ui.xss.cookieNote')),
    );
  } else {
    host.append(note('info', t('ui.xss.noAttempts')));
  }
}

function note(level: 'info' | 'warn' | 'success', text: string): HTMLElement {
  return h('p', { class: `note note-${level}` }, text);
}
