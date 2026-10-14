import type {
  BoolOption,
  FileOption,
  InputKind,
  NumberOption,
  OptionSpecs,
  SelectOption,
  TextOption,
  ToolDef,
} from './types';

/** Identity helper that gives full type inference on options inside run()/detect(). */
export function defineTool<K extends InputKind, const O extends OptionSpecs = Record<never, never>>(
  def: ToolDef<K, O>,
): ToolDef<K, O> {
  return def;
}

type Choice<T extends string> = T | { value: T; label: string };

export function select<const T extends string>(
  label: string,
  choices: readonly Choice<T>[],
  def: NoInfer<T>,
  extra: Partial<Omit<SelectOption<T>, 'type' | 'choices' | 'default' | 'label'>> = {},
): SelectOption<T> {
  return {
    type: 'select',
    label,
    choices: choices.map((c) => (typeof c === 'string' ? { value: c, label: c } : c)),
    default: def,
    ...extra,
  };
}

/** Two-to-four way toggle, e.g. toggle('Mode', ['decode', 'encode']). First choice is the default. */
export function toggle<const T extends string>(
  label: string,
  choices: readonly Choice<T>[],
  def?: NoInfer<T>,
  extra: Partial<Omit<SelectOption<T>, 'type' | 'choices' | 'default' | 'label'>> = {},
): SelectOption<T> {
  const first = choices[0];
  const fallback = (typeof first === 'string' ? first : first?.value) as T;
  return select(label, choices, def ?? fallback, { segmented: true, ...extra });
}

export function text(
  label: string,
  def = '',
  extra: Partial<Omit<TextOption, 'type' | 'default' | 'label'>> = {},
): TextOption {
  return { type: 'text', label, default: def, ...extra };
}

export function number(
  label: string,
  def: number,
  extra: Partial<Omit<NumberOption, 'type' | 'default' | 'label'>> = {},
): NumberOption {
  return { type: 'number', label, default: def, ...extra };
}

export function bool(
  label: string,
  def = false,
  extra: Partial<Omit<BoolOption, 'type' | 'default' | 'label'>> = {},
): BoolOption {
  return { type: 'bool', label, default: def, ...extra };
}

/** A second file input, e.g. file('Second image', 'image'). Its value is null until chosen. */
export function file<const K extends 'bytes' | 'image'>(
  label: string,
  kind: K,
  extra: Partial<Omit<FileOption<K>, 'type' | 'default' | 'label' | 'kind'>> = {},
): FileOption<K> {
  return { type: 'file', label, kind, default: null, ...extra };
}
