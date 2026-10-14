import { ToolError } from '../core/errors';
import { selectFlags } from '../core/flags';
import { resultToText } from '../core/result-text';
import { exampleToRaw, prepareInput, resolveExampleOptions, type RawInput } from '../core/prepare';
import { defaultOptions } from '../core/registry';
import { CancelledError, Runner } from '../core/runner';
import { CATEGORIES, type AnyTool, type ExampleInput, type OptionSpec } from '../core/types';
import { formatSize, fromBase64, fromHex, toHex } from '../lib/bytes';
import { identify } from '../lib/signatures';
import { clear, copyText, debounce, h } from './dom';
import { renderResult } from './outputs';
import { flagSettings } from './settings';

type PasteAs = 'text' | 'hex' | 'base64';

interface ToolState {
  text: string;
  pasteAs: PasteAs;
  file: { bytes: Uint8Array; name: string } | null;
  values: Record<string, unknown>;
}

const memory = new Map<string, ToolState>();
const runner = new Runner();

/** Set by triage / "Send to…" right before navigating to a tool. */
let pending: { toolId: string; raw: RawInput; options?: Record<string, unknown> } | null = null;
export function setPending(toolId: string, raw: RawInput, options?: Record<string, unknown>) {
  pending = { toolId, raw, options };
}

export async function loadSample(name: string): Promise<Uint8Array> {
  const res = await fetch(`samples/${encodeURIComponent(name)}`);
  if (!res.ok) throw new ToolError(`Sample "${name}" is missing.`);
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
  };
  memory.set(tool.id, state);
  if (pending?.toolId === tool.id) {
    applyRaw(pending.raw);
    Object.assign(state.values, pending.options ?? {});
    pending = null;
  }

  const live = tool.live ?? tool.input === 'text';
  const fileKind = tool.input === 'image' || tool.input === 'audio';
  let prepared: { key: unknown; value: unknown } | null = null;

  function applyRaw(raw: RawInput) {
    state.file = null;
    if (raw.bytes && (tool.input !== 'text' || raw.bytes.length > FILE_TEXT_LIMIT)) {
      state.file = { bytes: raw.bytes, name: raw.name ?? 'input.bin' };
    } else if (raw.bytes) {
      state.text = new TextDecoder().decode(raw.bytes);
      state.pasteAs = 'text';
    } else {
      state.text = raw.text ?? '';
      state.pasteAs = 'text';
    }
  }

  function currentRaw(): RawInput | null {
    if (state.file) return { bytes: state.file.bytes, name: state.file.name };
    if (!state.text) return null;
    if (tool.input === 'text' || state.pasteAs === 'text') return { text: state.text };
    return { bytes: state.pasteAs === 'hex' ? fromHex(state.text) : fromBase64(state.text) };
  }

  // ---------- layout ----------
  const cat = CATEGORIES.find((c) => c.id === tool.category);
  const status = h('span', { class: 'status', role: 'status', 'aria-live': 'polite' });
  const outBody = h('div', { class: 'out-stack' });
  const flagStrip = h('div', { class: 'flag-strip', hidden: true });
  const inputBox = h('div', { class: 'input-box' });
  const optionsBar = h('div', { class: 'options' });
  const runBtn = h('button', { type: 'button', class: 'btn btn-run', onclick: () => run() }, 'Run');

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
          cat?.name ?? tool.category,
        ),
        h('h1', null, tool.name),
        h('p', { class: 'tool-desc' }, tool.description),
      ),
      optionsBar,
      h(
        'div',
        { class: 'panes' },
        h(
          'section',
          { class: 'pane pane-in', 'aria-label': 'Input' },
          h(
            'div',
            { class: 'pane-head' },
            h('span', { class: 'pane-title' }, 'Input'),
            examplesBar(),
          ),
          inputBox,
        ),
        h(
          'section',
          { class: 'pane pane-out', 'aria-label': 'Output' },
          h(
            'div',
            { class: 'pane-head' },
            h('span', { class: 'pane-title' }, 'Output'),
            status,
            live ? null : runBtn,
          ),
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
      h('span', { class: 'examples-label' }, 'Try'),
      ...tool.examples.map((ex) =>
        h(
          'button',
          { type: 'button', class: 'chip', onclick: () => loadExample(ex.input, ex.options) },
          ex.label,
        ),
      ),
    );
  }

  async function loadExample(input: ExampleInput, options?: Record<string, unknown>) {
    state.file = null;
    try {
      state.values = {
        ...defaultOptions(tool),
        ...(await resolveExampleOptions(tool, options, loadSample)),
      };
      if (typeof input === 'object' && 'hex' in input && tool.input === 'bytes') {
        state.text = input.hex;
        state.pasteAs = 'hex';
      } else {
        applyRaw(await exampleToRaw(input, loadSample));
      }
    } catch (e) {
      showError(e);
      return;
    }
    prepared = null;
    renderOptions();
    renderInput();
    run();
  }

  // ---------- options ----------
  function renderOptions() {
    clear(optionsBar);
    const specs = Object.entries(tool.options ?? {});
    optionsBar.hidden = specs.length === 0;
    for (const [key, spec] of specs) {
      if (spec.showIf && !spec.showIf(state.values)) continue;
      optionsBar.append(optionControl(key, spec));
    }
  }

  function setValue(key: string, v: unknown) {
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
        { class: 'seg', role: 'group', 'aria-label': spec.label },
        ...spec.choices.map((c) =>
          h(
            'button',
            {
              type: 'button',
              'aria-pressed': String(v === c.value),
              onclick: () => setValue(key, c.value),
            },
            c.label,
          ),
        ),
      );
      return h(
        'div',
        { class: 'opt' },
        h('span', { class: 'opt-label' }, spec.label),
        control,
        hint(spec),
      );
    }
    if (spec.type === 'select') {
      control = h(
        'select',
        { id, onchange: (e: Event) => setValue(key, (e.target as HTMLSelectElement).value) },
        ...spec.choices.map((c) =>
          h('option', { value: c.value, selected: v === c.value }, c.label),
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
        spec.label,
        hint(spec),
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
        h('span', { class: 'opt-label' }, spec.label),
        picker,
        h(
          'button',
          { type: 'button', class: 'btn btn-ghost', onclick: () => picker.click() },
          chosen ?? 'Choose file',
        ),
        chosen
          ? h(
              'button',
              {
                type: 'button',
                class: 'btn btn-ghost',
                'aria-label': `Remove ${spec.label}`,
                onclick: () => setValue(key, null),
              },
              '×',
            )
          : null,
        hint(spec),
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
            state.values[key] = n;
            if (live) scheduleRun();
          }
        },
        onchange: () => renderOptions(),
      });
    } else {
      control = h('input', {
        id,
        type: 'text',
        value: String(v ?? ''),
        placeholder: spec.placeholder,
        spellcheck: false,
        autocomplete: 'off',
        oninput: (e: Event) => {
          state.values[key] = (e.target as HTMLInputElement).value;
          if (live) scheduleRun();
        },
      });
    }
    return h(
      'div',
      { class: 'opt' },
      h('label', { class: 'opt-label', for: id }, spec.label),
      control,
      hint(spec),
    );
  }

  function hint(spec: OptionSpec) {
    return spec.hint
      ? h('span', { class: 'opt-hint', title: spec.hint, 'aria-label': spec.hint }, '?')
      : null;
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
    const bytes = new Uint8Array(await f.arrayBuffer());
    applyRaw({ bytes, name: f.name });
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
          h('strong', null, tool.input === 'image' ? 'Drop an image' : 'Drop an audio file'),
          h('span', null, 'or click to open one — it never leaves your browser'),
        ),
      );
      return;
    }
    const ta = h('textarea', {
      class: 'input-text',
      spellcheck: false,
      autocomplete: 'off',
      placeholder:
        tool.placeholder ??
        (tool.input === 'bytes' ? 'Paste data or drop a file' : 'Paste text or drop a file'),
      'aria-label': 'Input',
      value: state.text,
      oninput: () => {
        state.text = ta.value;
        prepared = null;
        count.textContent = `${ta.value.length} chars`;
        if (live) scheduleRun();
      },
      onkeydown: (ev: KeyboardEvent) => {
        if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
          ev.preventDefault();
          run();
        }
      },
    });
    const count = h('span', { class: 'count' }, `${state.text.length} chars`);
    const pasteAs =
      tool.input === 'bytes'
        ? h(
            'label',
            { class: 'paste-as' },
            'Read as ',
            h(
              'select',
              {
                'aria-label': 'Interpret pasted text as',
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
                  v === 'text' ? 'UTF-8 text' : v,
                ),
              ),
            ),
          )
        : null;
    inputBox.append(
      ta,
      h(
        'div',
        { class: 'input-bar' },
        h(
          'button',
          { type: 'button', class: 'btn btn-ghost', onclick: () => fileInput.click() },
          'Open file',
        ),
        pasteAs,
        count,
        state.text
          ? h(
              'button',
              {
                type: 'button',
                class: 'btn btn-ghost',
                onclick: () => ((state.text = ''), renderInput(), showEmpty()),
              },
              'Clear',
            )
          : null,
      ),
    );
  }

  function fileCard(file: { bytes: Uint8Array; name: string }): HTMLElement {
    const kind = identify(file.bytes)[0];
    let preview: HTMLElement | null = null;
    if (tool.input === 'image' || (kind && kind.mime?.startsWith('image/'))) {
      const url = URL.createObjectURL(new Blob([file.bytes as BlobPart]));
      preview = h('img', { class: 'file-preview', src: url, alt: '' });
    } else if (tool.input === 'audio') {
      const url = URL.createObjectURL(new Blob([file.bytes as BlobPart]));
      preview = h('audio', { controls: true, src: url, class: 'file-audio' });
    }
    return h(
      'div',
      { class: 'file-card' },
      preview,
      h(
        'div',
        { class: 'file-info' },
        h('strong', { class: 'file-name' }, file.name),
        h('span', null, `${formatSize(file.bytes.length)}${kind ? ` · ${kind.name}` : ''}`),
        h('code', { class: 'file-head' }, toHex(file.bytes.subarray(0, 12), ' ')),
        h(
          'span',
          { class: 'file-actions' },
          h(
            'button',
            { type: 'button', class: 'btn btn-ghost', onclick: () => fileInput.click() },
            'Replace',
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-ghost',
              onclick: () => ((state.file = null), (prepared = null), renderInput(), showEmpty()),
            },
            'Remove',
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
      h(
        'p',
        { class: 'empty' },
        fileKind
          ? 'Open a file, or pick an example above.'
          : 'Paste input, or pick an example above.',
      ),
    );
  }

  function showError(e: unknown) {
    clear(outBody);
    flagStrip.hidden = true;
    const msg = e instanceof Error ? e.message : String(e);
    const user = e instanceof ToolError;
    outBody.append(
      h('p', { class: 'note note-error', role: 'alert' }, user ? msg : `Unexpected error: ${msg}`),
    );
  }

  async function run() {
    let raw: RawInput | null;
    try {
      raw = currentRaw();
    } catch (e) {
      showError(e);
      return;
    }
    if (!raw) return showEmpty();
    clearTimeout(busyTimer);
    busyTimer = setTimeout(() => (status.textContent = 'Running…'), 200);
    root.classList.add('is-busy');
    try {
      const key = raw.bytes ?? raw.text;
      if (!prepared || prepared.key !== key) {
        prepared = { key, value: await prepareInput(tool.input, raw) };
      }
      const t0 = performance.now();
      const result = await runner.run(tool.id, prepared.value, { ...state.values });
      const ms = performance.now() - t0;
      clear(outBody);
      const flags = selectFlags(resultToText(result), flagSettings.regex, flagSettings.pattern);
      outBody.append(
        ...renderResult(result, {
          highlight: flags,
          pipe: (id, r) => (setPending(id, r), open(id)),
        }),
      );
      if (!result.length) outBody.append(h('p', { class: 'empty' }, 'No output.'));
      renderFlags(flags);
      status.textContent = `${ms < 1 ? '<1' : Math.round(ms)} ms`;
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
    if (!flags.size) return;
    flagStrip.append(
      h(
        'span',
        { class: 'flag-strip-label' },
        flags.size === 1 ? 'Flag candidate' : `${flags.size} flag candidates`,
      ),
      ...[...flags].slice(0, 8).map((f) => {
        const b: HTMLButtonElement = h(
          'button',
          { type: 'button', class: 'flag-chip', title: 'Copy', onclick: () => copyText(f, b) },
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
