import { ToolError } from '../core/errors';
import { t } from '../i18n';
import {
  categoryName,
  choiceLabel,
  exampleLabel,
  optionHint,
  optionLabel,
  optionPlaceholder,
  toolDescription,
  toolName,
  toolPlaceholder,
} from '../i18n/tool-text';
import { selectFlags } from '../core/flags';
import { resultToText } from '../core/result-text';
import {
  audioFile,
  exampleToRaw,
  prepareInput,
  resolveExampleOptions,
  type RawInput,
} from '../core/prepare';
import { defaultOptions, getTool } from '../core/registry';
import { CancelledError, Runner } from '../core/runner';
import type { AnyTool, KeypadKey, OptionSpec, OptionSpecs, OptionValues } from '../core/types';
import { formatSize, fromBase64, fromHex, toHex } from '../lib/bytes';
import { identify } from '../lib/signatures';
import { clear, copyText, debounce, h } from './dom';
import { glyphSvg } from './glyph';
import { dragSettled, renderResult } from './outputs';
import { flagSettings } from './settings';

type PasteAs = 'text' | 'hex' | 'base64';

/**
 * The input on screen came from a built-in example (a "Try" chip), not from the user. While this
 * is set, the output pane says so, so a demo result can never be taken for the analysis of the
 * user's own file.
 */
interface DemoState {
  /** Tool the example belongs to, and its English label (translated when shown). */
  toolId: string;
  label: string;
  /** Sample file the example loaded; none for a text example. */
  sample?: string;
  /** Tool the demo data was piped from (when the demo is in another tool). */
  from?: string;
  /** Options the example set, and those the user changed by hand since (kept on leaving). */
  keys: string[];
  touched: Set<string>;
}

interface ToolState {
  text: string;
  pasteAs: PasteAs;
  /**
   * bytes for tools that need the whole file; blob (a handle, nothing read) for inputs 'file'
   * and 'audio' (audio is read and decoded in the tool worker, never on this thread).
   */
  file: { bytes?: Uint8Array; blob?: Blob; name: string; size: number } | null;
  values: Record<string, unknown>;
  demo: DemoState | null;
}

const memory = new Map<string, ToolState>();
const runner = new Runner();

/** Set by triage / "Send to…" right before navigating to a tool. */
let pending: {
  toolId: string;
  raw: RawInput;
  options?: Record<string, unknown>;
  demo?: { toolId: string; label: string; from: string };
} | null = null;
export function setPending(
  toolId: string,
  raw: RawInput,
  options?: Record<string, unknown>,
  demo?: { toolId: string; label: string; from: string },
) {
  pending = { toolId, raw, options, demo };
}

/** Back to defaults for the options an example set, except those the user changed by hand. */
function endDemo(tool: AnyTool, state: ToolState, resetOptions: boolean): boolean {
  const demo = state.demo;
  if (!demo) return false;
  state.demo = null;
  if (resetOptions) {
    const defaults = defaultOptions(tool);
    for (const key of demo.keys) if (!demo.touched.has(key)) state.values[key] = defaults[key];
  }
  return true;
}

export async function loadSample(name: string): Promise<Uint8Array> {
  const res = await fetch(`samples/${encodeURIComponent(name)}`);
  if (!res.ok) throw new ToolError(t('ui.tool.sampleMissing', { name }));
  return new Uint8Array(await res.arrayBuffer());
}

const FILE_TEXT_LIMIT = 2 * 1024 * 1024;

export function renderTool(
  tool: AnyTool,
  root: HTMLElement,
  open: (id: string) => void,
): () => void {
  const state: ToolState = memory.get(tool.id) ?? {
    text: '',
    pasteAs: 'text',
    file: null,
    values: defaultOptions(tool),
    demo: null,
  };
  memory.set(tool.id, state);
  /**
   * Inputs handed to the runner as a Blob handle (see ToolState.file). Declared before the
   * pending input below, which applyRaw reads it for.
   */
  const byHandle = tool.input === 'file' || tool.input === 'audio';
  if (pending?.toolId === tool.id) {
    // New data from triage or "Send to…": whatever example was on screen is gone.
    endDemo(tool, state, true);
    applyRaw(pending.raw);
    Object.assign(state.values, pending.options ?? {});
    if (pending.demo) state.demo = { ...pending.demo, keys: [], touched: new Set() };
    pending = null;
  }

  const live = tool.live ?? tool.input === 'text';
  const fileKind = tool.input === 'image' || tool.input === 'audio' || tool.input === 'file';
  let prepared: { key: unknown; value: unknown } | null = null;

  function applyRaw(raw: RawInput) {
    state.file = null;
    if (raw.file && (byHandle || !raw.bytes)) {
      state.file = { blob: raw.file, name: raw.name ?? 'input.bin', size: raw.file.size };
    } else if (raw.bytes && tool.input === 'audio') {
      // One copy into a Blob now, instead of one to the worker on every run.
      const blob = new Blob([raw.bytes as BlobPart]);
      state.file = { blob, name: raw.name ?? 'input.bin', size: blob.size };
    } else if (raw.bytes && (tool.input !== 'text' || raw.bytes.length > FILE_TEXT_LIMIT)) {
      state.file = { bytes: raw.bytes, name: raw.name ?? 'input.bin', size: raw.bytes.length };
    } else if (raw.bytes) {
      state.text = new TextDecoder().decode(raw.bytes);
      state.pasteAs = 'text';
    } else {
      state.text = raw.text ?? '';
      state.pasteAs = 'text';
    }
  }

  function currentRaw(): RawInput | null {
    if (state.file)
      return { bytes: state.file.bytes, file: state.file.blob, name: state.file.name };
    if (!state.text) return null;
    if (tool.input === 'text' || state.pasteAs === 'text') return { text: state.text };
    return { bytes: state.pasteAs === 'hex' ? fromHex(state.text) : fromBase64(state.text) };
  }

  // ---------- layout ----------
  const status = h('span', { class: 'status', role: 'status', 'aria-live': 'polite' });
  const outBody = h('div', { class: 'out-stack' });
  const flagStrip = h('div', { class: 'flag-strip', hidden: true });
  const demoBanner = h('div', { class: 'demo-banner', role: 'note', hidden: true });
  const inputBox = h('div', { class: 'input-box' });
  /** The on-screen symbol keyboard of a tool that has one (see ToolDef.keypad). */
  const keypadBox = h('div', { class: 'keypad-box' });
  /** The text box on screen and its counter: the keypad types into them. */
  let typing: {
    ta: HTMLTextAreaElement;
    count: HTMLElement;
    /** Selection the text box had when it last lost the focus; null: never used. */
    caret: [number, number] | null;
  } | null = null;
  const optionsBar = h('div', { class: 'options' });
  const runBtn = h(
    'button',
    { type: 'button', class: 'btn btn-run', onclick: () => run() },
    t('ui.tool.run'),
  );

  root.append(
    h(
      'article',
      { class: 'tool', 'data-tool': tool.id },
      h(
        'header',
        { class: 'tool-head' },
        h(
          'p',
          { class: 'crumb' },
          h('span', { class: `glyph glyph-${tool.category}`, 'aria-hidden': 'true' }),
          categoryName(tool.category),
        ),
        h('h1', null, toolName(tool)),
        h('p', { class: 'tool-desc' }, toolDescription(tool)),
      ),
      optionsBar,
      h(
        'div',
        { class: 'panes' },
        h(
          'section',
          { class: 'pane pane-in', 'aria-label': t('ui.tool.input') },
          h(
            'div',
            { class: 'pane-head' },
            h('span', { class: 'pane-title' }, t('ui.tool.input')),
            examplesBar(),
          ),
          inputBox,
        ),
        h(
          'section',
          { class: 'pane pane-out', 'aria-label': t('ui.tool.output') },
          h(
            'div',
            { class: 'pane-head' },
            h('span', { class: 'pane-title' }, t('ui.tool.output')),
            status,
            live ? null : runBtn,
          ),
          demoBanner,
          flagStrip,
          outBody,
        ),
      ),
    ),
  );

  function examplesBar(): HTMLElement {
    return h(
      'div',
      { class: 'examples' },
      h('span', { class: 'examples-label' }, t('ui.tool.try')),
      ...tool.examples.map((ex) =>
        h(
          'button',
          { type: 'button', class: 'chip', onclick: () => loadExample(ex) },
          exampleLabel(tool, ex.label),
        ),
      ),
    );
  }

  // ---------- demo ----------
  /** Banner above the output while the input is a built-in example (never the user's data). */
  function renderDemoBanner() {
    clear(demoBanner);
    const demo = state.demo;
    demoBanner.hidden = !demo;
    if (!demo) return;
    const source = getTool(demo.toolId) ?? tool;
    const label = exampleLabel(source, demo.label);
    const line = demo.from
      ? t('ui.demo.pipedLine', { label, tool: toolName(getTool(demo.from) ?? tool) })
      : demo.sample
        ? t('ui.demo.fileLine', { label, name: demo.sample })
        : t('ui.demo.textLine', { label });
    demoBanner.append(
      h('span', { class: 'demo-badge' }, t('ui.demo.badge')),
      ' ',
      h('span', { class: 'demo-line' }, line),
      ' ',
      h('span', { class: 'demo-note' }, t('ui.demo.note')),
    );
  }

  /** The user's own input replaces the example: no demo banner, example options back to default. */
  function leaveDemo(resetOptions: boolean) {
    if (!endDemo(tool, state, resetOptions)) return false;
    if (resetOptions) renderOptions();
    renderDemoBanner();
    return true;
  }

  /** An option changed by hand: it stays when the example is replaced. */
  const touch = (key: string) => state.demo?.touched.add(key);

  /** New input is on its way: nothing of the previous input (or of a demo) stays on screen. */
  function showAnalysing(name?: string) {
    runCount++; // a result still in flight belongs to the previous input
    clear(outBody);
    flagStrip.hidden = true;
    status.textContent = '';
    outBody.append(
      h(
        'p',
        { class: 'empty analysing', role: 'status' },
        name ? t('ui.tool.analysing', { name }) : t('ui.tool.analysingInput'),
      ),
    );
  }

  let inputSeq = 0;

  async function loadExample(ex: AnyTool['examples'][number]) {
    const { input, options } = ex;
    const seq = ++inputSeq;
    const sample = typeof input === 'object' && 'sample' in input ? input.sample : undefined;
    state.demo = null;
    renderDemoBanner();
    showAnalysing(sample);
    try {
      const values = {
        ...defaultOptions(tool),
        ...(await resolveExampleOptions(tool, options, loadSample)),
      };
      let text = state.text;
      let pasteAs = state.pasteAs;
      let raw: RawInput | null = null;
      if (typeof input === 'object' && 'hex' in input && tool.input === 'bytes') {
        text = input.hex;
        pasteAs = 'hex';
      } else {
        raw = await exampleToRaw(input, loadSample);
      }
      if (seq !== inputSeq) return; // another input was chosen while the sample loaded
      state.file = null;
      state.values = values;
      state.text = text;
      state.pasteAs = pasteAs;
      if (raw) applyRaw(raw);
    } catch (e) {
      if (seq === inputSeq) showError(e);
      return;
    }
    state.demo = {
      toolId: tool.id,
      label: ex.label,
      sample,
      keys: Object.keys(options ?? {}),
      touched: new Set(),
    };
    prepared = null;
    renderDemoBanner();
    renderOptions();
    renderInput();
    run();
  }

  // ---------- options ----------
  const visibleKeys = () =>
    Object.entries(tool.options ?? {})
      .filter(([, spec]) => !spec.showIf || spec.showIf(state.values))
      .map(([key]) => key)
      .join(',');
  let shownKeys = '';

  function renderOptions() {
    clear(optionsBar);
    const specs = Object.entries(tool.options ?? {});
    optionsBar.hidden = specs.length === 0;
    for (const [key, spec] of specs) {
      if (spec.showIf && !spec.showIf(state.values)) continue;
      optionsBar.append(optionControl(key, spec));
    }
    shownKeys = visibleKeys();
    renderKeypad();
  }

  /** Re-render only when a value changes which options are shown (keeps focus while typing). */
  function refreshOptionsIfNeeded() {
    if (visibleKeys() !== shownKeys) renderOptions();
  }

  function setValue(key: string, v: unknown) {
    touch(key);
    state.values[key] = v;
    renderOptions();
    if (live) scheduleRun();
  }

  function optionControl(key: string, spec: OptionSpec): HTMLElement {
    const id = `opt-${tool.id}-${key}`;
    const v = state.values[key];
    let control: HTMLElement;
    if (spec.type === 'select' && spec.segmented) {
      control = h(
        'span',
        { class: 'seg', role: 'group', 'aria-label': optionLabel(tool, key, spec) },
        ...spec.choices.map((c) =>
          h(
            'button',
            {
              type: 'button',
              'aria-pressed': String(v === c.value),
              onclick: () => setValue(key, c.value),
            },
            choiceLabel(tool, key, c.value, c.label),
          ),
        ),
      );
      return h(
        'div',
        { class: 'opt' },
        h('span', { class: 'opt-label' }, optionLabel(tool, key, spec)),
        control,
        hint(key, spec),
      );
    }
    if (spec.type === 'select') {
      control = h(
        'select',
        { id, onchange: (e: Event) => setValue(key, (e.target as HTMLSelectElement).value) },
        ...spec.choices.map((c) =>
          h(
            'option',
            { value: c.value, selected: v === c.value },
            choiceLabel(tool, key, c.value, c.label),
          ),
        ),
      );
    } else if (spec.type === 'bool') {
      return h(
        'label',
        { class: 'opt opt-bool' },
        h('input', {
          type: 'checkbox',
          checked: Boolean(v),
          onchange: (e: Event) => setValue(key, (e.target as HTMLInputElement).checked),
        }),
        optionLabel(tool, key, spec),
        hint(key, spec),
      );
    } else if (spec.type === 'file') {
      const picker = h('input', {
        type: 'file',
        hidden: true,
        accept: spec.kind === 'image' ? 'image/*' : undefined,
        onchange: async () => {
          const f = picker.files?.[0];
          if (!f) return;
          const bytes = new Uint8Array(await f.arrayBuffer());
          try {
            setValue(key, await prepareInput(spec.kind, { bytes, name: f.name }));
          } catch (e) {
            showError(e);
          }
        },
      });
      const chosen =
        v && typeof v === 'object' && 'name' in v
          ? String((v as { name?: string }).name ?? 'file')
          : null;
      return h(
        'div',
        { class: 'opt' },
        h('span', { class: 'opt-label' }, optionLabel(tool, key, spec)),
        picker,
        h(
          'button',
          { type: 'button', class: 'btn btn-ghost', onclick: () => picker.click() },
          chosen ?? t('ui.tool.chooseFile'),
        ),
        chosen
          ? h(
              'button',
              {
                type: 'button',
                class: 'btn btn-ghost',
                'aria-label': t('ui.tool.removeFile', { label: optionLabel(tool, key, spec) }),
                onclick: () => setValue(key, null),
              },
              '×',
            )
          : null,
        hint(key, spec),
      );
    } else if (spec.type === 'number') {
      control = h('input', {
        id,
        type: 'number',
        value: String(v),
        min: spec.min,
        max: spec.max,
        step: spec.step ?? 1,
        class: 'num',
        oninput: (e: Event) => {
          const n = Number((e.target as HTMLInputElement).value);
          if (Number.isFinite(n)) {
            touch(key);
            state.values[key] = n;
            if (live) scheduleRun();
          }
        },
        onchange: () => refreshOptionsIfNeeded(),
      });
    } else {
      control = h('input', {
        id,
        type: 'text',
        value: String(v ?? ''),
        placeholder: optionPlaceholder(tool, key, spec),
        spellcheck: false,
        autocomplete: 'off',
        oninput: (e: Event) => {
          touch(key);
          state.values[key] = (e.target as HTMLInputElement).value;
          if (live) scheduleRun();
        },
        onchange: () => refreshOptionsIfNeeded(),
      });
    }
    return h(
      'div',
      { class: 'opt' },
      h('label', { class: 'opt-label', for: id }, optionLabel(tool, key, spec)),
      control,
      hint(key, spec),
    );
  }

  function hint(key: string, spec: OptionSpec) {
    const text = optionHint(tool, key, spec);
    return text ? h('span', { class: 'opt-hint', title: text, 'aria-label': text }, '?') : null;
  }

  // ---------- symbol keyboard ----------
  const hasKeypad = tool.input === 'text' && tool.keypad !== undefined;
  const keypadNote = h('span', { class: 'visually-hidden', role: 'status', 'aria-live': 'polite' });

  /** A change to the text: what goes where the selection is (from..to), and where the caret ends. */
  type Edit = (text: string, from: number, to: number) => { text: string; caret: number };
  const insertText =
    (add: string): Edit =>
    (text, from, to) => ({
      text: text.slice(0, from) + add + text.slice(to),
      caret: from + add.length,
    });
  /** Delete the selection, or the character (a whole code point) before the caret. */
  const backspace: Edit = (text, from, to) => {
    const start = from === to ? from - ([...text.slice(0, from)].at(-1)?.length ?? 0) : from;
    return { text: text.slice(0, start) + text.slice(to), caret: start };
  };
  const clearAll: Edit = () => ({ text: '', caret: 0 });

  /**
   * Edit the input text from a key, at the caret (or over the selection) of the text box: the one
   * it has now when it has the focus, the one it had when it lost it otherwise (a click on a key
   * takes the focus away), the end of the text when it was never used. The edit counts as typing:
   * a demo ends and a live tool runs again.
   */
  function pressKey(label: string, edit: Edit) {
    const box = typing;
    if (!box) return;
    const length = box.ta.value.length;
    const [from, to] =
      document.activeElement === box.ta
        ? [box.ta.selectionStart, box.ta.selectionEnd]
        : (box.caret ?? [length, length]);
    const next = edit(box.ta.value, Math.min(from, length), Math.min(to, length));
    box.ta.value = next.text;
    box.ta.setSelectionRange(next.caret, next.caret);
    box.caret = [next.caret, next.caret];
    state.text = next.text;
    box.count.textContent = t('ui.input.chars', { count: next.text.length });
    prepared = null;
    inputSeq++; // pressing a key wins over an example or a file still being loaded
    if (leaveDemo(false)) {
      if (live) showAnalysing();
      else showPressRun();
    }
    keypadNote.textContent = label;
    if (live) scheduleRun();
  }

  function renderKeypad() {
    clear(keypadBox);
    keypadBox.hidden = !hasKeypad;
    if (!hasKeypad || !tool.keypad) return;
    const keys: KeypadKey[] = tool.keypad(state.values as OptionValues<OptionSpecs>);
    const control = (id: string, label: string, edit: Edit) =>
      h(
        'button',
        {
          type: 'button',
          class: 'key key-ctl',
          'data-key': id,
          onclick: () => pressKey(label, edit),
        },
        label,
      );
    keypadBox.append(
      h(
        'div',
        { class: 'keypad', role: 'group', 'aria-label': t('ui.keypad.label') },
        ...keys.map((k) =>
          h(
            'button',
            {
              type: 'button',
              class: 'key',
              'data-key': k.text,
              'aria-label': k.label,
              title: k.label,
              onclick: () => pressKey(k.label, insertText(k.text)),
            },
            glyphSvg(k.glyph),
          ),
        ),
      ),
      h(
        'div',
        { class: 'keypad-ctl' },
        control('space', t('ui.keypad.space'), insertText(' ')),
        control('backspace', t('ui.keypad.backspace'), backspace),
        control('clear', t('ui.keypad.clear'), clearAll),
        h('span', { class: 'keypad-hint' }, t('ui.keypad.hint')),
        keypadNote,
      ),
    );
  }

  // ---------- input ----------
  const fileInput = h('input', {
    type: 'file',
    hidden: true,
    accept:
      tool.input === 'image' ? 'image/*' : tool.input === 'audio' ? 'audio/*,.wav' : undefined,
    onchange: () => {
      const f = fileInput.files?.[0];
      if (f) void takeFile(f);
      fileInput.value = '';
    },
  });

  async function takeFile(f: File) {
    const seq = ++inputSeq;
    // The user's own file: leave the demo (and its options) and clear the old output at once.
    leaveDemo(true);
    showAnalysing(f.name);
    // Tools reading on demand get the handle only: a 4 GB disk image is never loaded whole.
    // Audio too: the worker reads and decodes it, so a long recording never blocks this thread.
    if (byHandle) applyRaw({ file: f, name: f.name });
    else {
      const bytes = new Uint8Array(await f.arrayBuffer());
      if (seq !== inputSeq) return; // a newer input replaced this one while it was read
      applyRaw({ bytes, name: f.name });
    }
    prepared = null;
    renderInput();
    run();
  }

  function onDrop(ev: DragEvent) {
    ev.preventDefault();
    root.classList.remove('is-dragging');
    const f = ev.dataTransfer?.files?.[0];
    if (f) void takeFile(f);
  }

  function renderInput() {
    clear(inputBox);
    typing = null;
    inputBox.classList.toggle('has-keypad', hasKeypad);
    inputBox.append(fileInput);
    if (state.file) {
      inputBox.append(fileCard(state.file));
      return;
    }
    if (fileKind) {
      inputBox.append(
        h(
          'button',
          { type: 'button', class: 'dropzone', onclick: () => fileInput.click() },
          h(
            'strong',
            null,
            t(tool.input === 'image' ? 'ui.input.dropImage' : 'ui.input.dropAudio'),
          ),
          h('span', null, t('ui.input.dropHint')),
        ),
      );
      return;
    }
    const ta = h('textarea', {
      class: 'input-text',
      spellcheck: false,
      autocomplete: 'off',
      placeholder:
        toolPlaceholder(tool) ??
        t(tool.input === 'bytes' ? 'ui.input.placeholderBytes' : 'ui.input.placeholderText'),
      'aria-label': t('ui.tool.input'),
      value: state.text,
      oninput: () => {
        state.text = ta.value;
        prepared = null;
        count.textContent = t('ui.input.chars', { count: ta.value.length });
        inputSeq++; // typing wins over an example or a file still being loaded
        // The first edit of an example makes it the user's text: drop the demo output at once.
        if (leaveDemo(false)) {
          if (live) showAnalysing();
          else showPressRun();
        }
        if (live) scheduleRun();
      },
      onkeydown: (ev: KeyboardEvent) => {
        if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
          ev.preventDefault();
          run();
        }
      },
    });
    const count = h('span', { class: 'count' }, t('ui.input.chars', { count: state.text.length }));
    const pasteAs =
      tool.input === 'bytes'
        ? h(
            'label',
            { class: 'paste-as' },
            `${t('ui.input.readAs')} `,
            h(
              'select',
              {
                'aria-label': t('ui.input.readAsLabel'),
                onchange: (e: Event) => {
                  state.pasteAs = (e.target as HTMLSelectElement).value as PasteAs;
                  prepared = null;
                  if (live) scheduleRun();
                },
              },
              ...(['text', 'hex', 'base64'] as const).map((v) =>
                h(
                  'option',
                  { value: v, selected: state.pasteAs === v },
                  v === 'text' ? t('ui.input.utf8') : v,
                ),
              ),
            ),
          )
        : null;
    const box = { ta, count, caret: null as [number, number] | null };
    typing = box;
    ta.addEventListener('blur', () => (box.caret = [ta.selectionStart, ta.selectionEnd]));
    inputBox.append(
      ta,
      keypadBox,
      h(
        'div',
        { class: 'input-bar' },
        h(
          'button',
          { type: 'button', class: 'btn btn-ghost', onclick: () => fileInput.click() },
          t('ui.input.openFile'),
        ),
        pasteAs,
        count,
        state.text
          ? h(
              'button',
              {
                type: 'button',
                class: 'btn btn-ghost',
                onclick: () => (
                  leaveDemo(true),
                  (state.text = ''),
                  (inputSeq += 1),
                  renderInput(),
                  showEmpty()
                ),
              },
              t('ui.input.clear'),
            )
          : null,
      ),
    );
  }

  function fileCard(file: NonNullable<ToolState['file']>): HTMLElement {
    const info = h('span', null, formatSize(file.size));
    const head = h('code', { class: 'file-head' });
    const showHead = (bytes: Uint8Array) => {
      const kind = identify(bytes)[0];
      info.textContent = `${formatSize(file.size)}${kind ? ` · ${kind.name}` : ''}`;
      head.textContent = toHex(bytes.subarray(0, 12), ' ');
      return kind;
    };
    let preview: HTMLElement | null = null;
    const src = file.blob ?? new Blob([file.bytes as BlobPart]);
    if (file.bytes) {
      const kind = showHead(file.bytes);
      if (tool.input === 'image' || (kind && kind.mime?.startsWith('image/'))) {
        preview = h('img', { class: 'file-preview', src: URL.createObjectURL(src), alt: '' });
      }
    } else {
      // Only the first bytes are read, whatever the file size.
      void src
        .slice(0, 4096)
        .arrayBuffer()
        .then((b) => showHead(new Uint8Array(b)));
    }
    if (tool.input === 'audio') {
      preview = h('audio', { controls: true, src: URL.createObjectURL(src), class: 'file-audio' });
    }
    return h(
      'div',
      { class: 'file-card' },
      preview,
      h(
        'div',
        { class: 'file-info' },
        h('strong', { class: 'file-name' }, file.name),
        info,
        head,
        h(
          'span',
          { class: 'file-actions' },
          h(
            'button',
            { type: 'button', class: 'btn btn-ghost', onclick: () => fileInput.click() },
            t('ui.input.replace'),
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-ghost',
              onclick: () => (
                leaveDemo(true),
                (state.file = null),
                (prepared = null),
                (inputSeq += 1),
                runner.release(),
                renderInput(),
                showEmpty()
              ),
            },
            t('ui.input.remove'),
          ),
        ),
      ),
    );
  }

  // ---------- run ----------
  let busyTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleRun = debounce(() => run(), 140);

  function showEmpty() {
    clear(outBody);
    flagStrip.hidden = true;
    status.textContent = '';
    outBody.append(
      h('p', { class: 'empty' }, t(fileKind ? 'ui.tool.emptyFile' : 'ui.tool.emptyText')),
    );
  }

  function showPressRun() {
    runCount++;
    clear(outBody);
    flagStrip.hidden = true;
    status.textContent = '';
    outBody.append(h('p', { class: 'empty' }, t('ui.tool.pressRun')));
  }

  function showError(e: unknown) {
    clear(outBody);
    flagStrip.hidden = true;
    const msg = e instanceof Error ? e.message : String(e);
    const user = e instanceof ToolError;
    outBody.append(
      h(
        'p',
        { class: 'note note-error', role: 'alert' },
        user ? msg : t('ui.tool.unexpected', { message: msg }),
      ),
    );
  }

  let runCount = 0;
  async function run() {
    const runId = ++runCount;
    let raw: RawInput | null;
    try {
      raw = currentRaw();
    } catch (e) {
      showError(e);
      return;
    }
    if (!raw) return showEmpty();
    clearTimeout(busyTimer);
    busyTimer = setTimeout(() => (status.textContent = t('ui.tool.running')), 200);
    root.classList.add('is-busy');
    try {
      const key = raw.bytes ?? raw.file ?? raw.text;
      if (!prepared || prepared.key !== key) {
        // Audio is decoded by the runner's worker (and kept there between runs), not here.
        const value =
          tool.input === 'audio'
            ? audioFile(raw.file ?? new Blob([(raw.bytes ?? raw.text ?? '') as BlobPart]), raw.name)
            : await prepareInput(tool.input, raw);
        prepared = { key, value };
      }
      const t0 = performance.now();
      const result = await runner.run(tool.id, prepared.value, { ...state.values });
      const ms = performance.now() - t0;
      // A reorder list being dragged stays in place until the drop, which starts a newer run.
      await dragSettled();
      if (runId !== runCount) return;
      clear(outBody);
      const flags = selectFlags(resultToText(result), flagSettings.regex, flagSettings.pattern);
      outBody.append(
        ...renderResult(result, {
          highlight: flags,
          pipe: (id, r) => (
            setPending(
              id,
              r,
              undefined,
              state.demo
                ? { toolId: state.demo.toolId, label: state.demo.label, from: tool.id }
                : undefined,
            ),
            open(id)
          ),
          setOptions: (values) => {
            for (const key of Object.keys(values)) touch(key);
            Object.assign(state.values, values);
            renderOptions();
            run();
          },
        }),
      );
      if (!result.length) outBody.append(h('p', { class: 'empty' }, t('ui.tool.noOutput')));
      renderFlags(flags);
      status.textContent = ms < 1 ? '<1 ms' : `${Math.round(ms)} ms`;
    } catch (e) {
      if (e instanceof CancelledError) return;
      status.textContent = '';
      showError(e);
    } finally {
      clearTimeout(busyTimer);
      root.classList.remove('is-busy');
    }
  }

  function renderFlags(flags: Set<string>) {
    clear(flagStrip);
    flagStrip.hidden = flags.size === 0;
    flagStrip.classList.toggle('is-demo', Boolean(state.demo));
    if (!flags.size) return;
    // Candidates found in a demo sample are not findings about the user's file.
    flagStrip.append(
      h(
        'span',
        { class: 'flag-strip-label' },
        state.demo
          ? t('ui.flags.demoCandidates', { count: flags.size })
          : t('ui.flags.candidates', { count: flags.size }),
      ),
      ...[...flags].slice(0, 8).map((f) => {
        const b: HTMLButtonElement = h(
          'button',
          {
            type: 'button',
            class: 'flag-chip',
            title: t('ui.out.copy'),
            onclick: () => copyText(f, b),
          },
          f,
        );
        return b;
      }),
    );
  }

  // Global drag & drop on the tool area.
  const onDragOver = (ev: DragEvent) => {
    if (ev.dataTransfer?.types.includes('Files')) {
      ev.preventDefault();
      root.classList.add('is-dragging');
    }
  };
  const onDragLeave = (ev: DragEvent) => {
    if (ev.target === root || !root.contains(ev.relatedTarget as Node))
      root.classList.remove('is-dragging');
  };
  root.addEventListener('dragover', onDragOver);
  root.addEventListener('dragleave', onDragLeave);
  root.addEventListener('drop', onDrop);
  const offFlags = flagSettings.onChange(() => run());

  renderDemoBanner();
  renderOptions();
  renderInput();
  if (currentRawSafe()) run();
  else showEmpty();

  function currentRawSafe() {
    try {
      return currentRaw();
    } catch {
      return null;
    }
  }

  return () => {
    offFlags();
    root.removeEventListener('dragover', onDragOver);
    root.removeEventListener('dragleave', onDragLeave);
    root.removeEventListener('drop', onDrop);
  };
}
