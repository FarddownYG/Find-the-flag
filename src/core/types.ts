/**
 * Core contracts. A tool is a pure function: (input, options) -> outputs.
 * The shell builds every widget from these declarations, so a tool never touches the DOM.
 */

export type Category = 'encoding' | 'crypto' | 'stego' | 'forensics' | 'audio' | 'misc';

export const CATEGORIES: { id: Category; name: string; blurb: string }[] = [
  { id: 'encoding', name: 'Encoding', blurb: 'Bases, charcodes, URL, morse, auto-decode' },
  { id: 'crypto', name: 'Crypto', blurb: 'Classical ciphers, XOR, hashes, JWT' },
  { id: 'stego', name: 'Steganography', blurb: 'Pixels, bit planes, metadata, hidden text' },
  { id: 'forensics', name: 'Forensics', blurb: 'Hexdump, magic bytes, carving, archives' },
  { id: 'audio', name: 'Audio', blurb: 'Spectrogram, tones' },
  { id: 'misc', name: 'Misc', blurb: 'Converters and text utilities' },
];

/** RGBA, 8 bits per channel, row-major. Same shape as DOM ImageData but usable in Node/workers. */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface FileInput {
  /** Raw bytes as provided (file or pasted text, UTF-8 / hex / base64 per the input bar). */
  bytes: Uint8Array;
  name?: string;
}

export interface ImageInput extends FileInput {
  /** Exact pixels (PNG/BMP decoded in pure JS; other formats via the browser decoder). */
  image: RgbaImage;
}

export interface AudioInput extends FileInput {
  sampleRate: number;
  /** One Float32Array per channel, samples in [-1, 1]. */
  channels: Float32Array[];
}

/**
 * A file read on demand: nothing is loaded up front, so multi-gigabyte disk images stay usable.
 * The worker receives only the Blob handle; read() slices it.
 */
export interface LazyFile {
  name?: string;
  size: number;
  blob: Blob;
  /** Bytes [offset, offset + length), clamped to the file. */
  read(offset: number, length: number): Promise<Uint8Array>;
}

export type InputKind = 'text' | 'bytes' | 'image' | 'audio' | 'file';

export type InputValue<K extends InputKind> = K extends 'text'
  ? string
  : K extends 'bytes'
    ? FileInput
    : K extends 'image'
      ? ImageInput
      : K extends 'audio'
        ? AudioInput
        : K extends 'file'
          ? LazyFile
          : never;

// ---------- options ----------

interface OptionBase<T> {
  label: string;
  default: T;
  hint?: string;
  /** Hide the control unless this returns true for the current values. */
  showIf?: (values: Record<string, unknown>) => boolean;
}

export interface SelectOption<T extends string = string> extends OptionBase<T> {
  type: 'select';
  choices: readonly { value: T; label: string }[];
  /** Render as a segmented toggle (good for 2-4 choices such as encode/decode). */
  segmented?: boolean;
}
export interface TextOption extends OptionBase<string> {
  type: 'text';
  placeholder?: string;
}
export interface NumberOption extends OptionBase<number> {
  type: 'number';
  min?: number;
  max?: number;
  step?: number;
}
export interface BoolOption extends OptionBase<boolean> {
  type: 'bool';
}

/** A second file next to the main input (e.g. the other image to XOR with). Null until chosen. */
export interface FileOption<
  K extends 'bytes' | 'image' = 'bytes' | 'image',
> extends OptionBase<null> {
  type: 'file';
  kind: K;
}

export type OptionSpec = SelectOption | TextOption | NumberOption | BoolOption | FileOption;
export type OptionSpecs = Record<string, OptionSpec>;

export type OptionValues<O> = {
  [K in keyof O]: O[K] extends SelectOption<infer T>
    ? T
    : O[K] extends NumberOption
      ? number
      : O[K] extends BoolOption
        ? boolean
        : O[K] extends FileOption<'image'>
          ? ImageInput | null
          : O[K] extends FileOption<'bytes'>
            ? FileInput | null
            : string;
};

/** Example option values: file options take a sample name instead of loaded data. */
export type ExampleOptions<V> = {
  [K in keyof V]?: V[K] extends FileInput | null ? { sample: string } : V[K];
};

// ---------- outputs ----------

export type Output =
  | { type: 'text'; label?: string; value: string }
  | { type: 'bytes'; label?: string; value: Uint8Array; filename?: string }
  | {
      type: 'table';
      label?: string;
      columns: string[];
      rows: (string | number)[][];
      /** Row index -> true: emphasise that row (e.g. best candidate). */
      highlight?: number[];
    }
  | { type: 'kv'; label?: string; entries: [string, string][] }
  | { type: 'image'; label?: string; image: RgbaImage; filename?: string }
  | {
      type: 'files';
      label?: string;
      /** For large results pass `blob` (and an empty `data`): it is downloaded as-is. */
      files: { name: string; data: Uint8Array; blob?: Blob; note?: string }[];
    }
  /** An encoded image shown as-is (JPEG thumbnail, embedded PNG...), with download and "Send to". */
  | { type: 'picture'; label?: string; data: Uint8Array; mime: string; filename?: string }
  /**
   * A location. Coordinates and map links render with no network access; the interactive map
   * only loads OpenStreetMap tiles after the user clicks "Show map".
   */
  | { type: 'map'; label?: string; lat: number; lon: number; zoom?: number }
  | { type: 'note'; level: 'info' | 'warn' | 'error' | 'success'; text: string };

export type ToolResult = Output[];

/** What the home "triage" box hands to each tool's detect(). */
export interface Sample {
  text: string | null;
  bytes: Uint8Array;
  name?: string;
}

export interface Detection<O = Record<string, unknown>> {
  /** 0..1 — how confident the tool is that it is the right one for this sample. */
  score: number;
  /** Options to preselect when the user opens the tool from triage. */
  options?: Partial<O>;
  reason?: string;
}

export type ExampleInput = string | { sample: string } | { hex: string };

export interface Example<O> {
  label: string;
  input: ExampleInput;
  options?: ExampleOptions<O>;
  /** Substring that must appear in the rendered output. Used by the unit + browser test suites. */
  expect: string;
}

export interface ToolDef<K extends InputKind = InputKind, O extends OptionSpecs = OptionSpecs> {
  /** Unique, kebab-case, stable: it is the URL (#/tool/<id>). */
  id: string;
  name: string;
  category: Category;
  /** One line, shown under the title and in search results. */
  description: string;
  /** Extra search keywords (aliases, tool names people know: "zsteg", "binwalk"...). */
  tags?: string[];
  input: K;
  /** Placeholder for the input box — show the expected format. */
  placeholder?: string;
  options?: O;
  /** Re-run on every keystroke/option change. Default: true for text, false otherwise. */
  live?: boolean;
  examples: Example<OptionValues<O>>[];
  detect?: (sample: Sample) => Detection<OptionValues<O>> | null;
  run: (input: InputValue<K>, options: OptionValues<O>) => ToolResult | Promise<ToolResult>;
}

/** Erased form used by the registry and the shell. */
export type AnyTool = ToolDef<InputKind, OptionSpecs>;
