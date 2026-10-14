/**
 * Declarative tool text (name, description, option labels, choices, hints, examples) is written
 * in English in the tool file and translated through derived keys:
 *   tool.<id>.name · tool.<id>.description · tool.<id>.placeholder
 *   tool.<id>.options.<key>.label | .hint | .placeholder | .choices.<value>
 *   tool.<id>.examples.<slug of the English label>
 *   cat.<id>.name · cat.<id>.blurb
 * `npm run i18n:extract` copies the English text into en.json; `npm run i18n:check` makes sure
 * every locale has every key. Runtime text (outputs, notes, errors) uses t('tool.<id>.…').
 */
import type { AnyTool, Category, OptionSpec } from '../core/types';
import { CATEGORIES } from '../core/types';
import { t, tOr, type Params } from './index';

export const slug = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '') || 'x';

const k = (id: string, ...parts: (string | number)[]) => ['tool', id, ...parts].join('.');

/** Runtime strings of one tool: const T = toolT('base64'); T('note.binary', { size }). */
export const toolT =
  (id: string) =>
  (key: string, params?: Params): string =>
    t(k(id, key), params);

export const toolName = (tool: AnyTool) => tOr(k(tool.id, 'name'), tool.name);
export const toolDescription = (tool: AnyTool) => tOr(k(tool.id, 'description'), tool.description);
export const toolPlaceholder = (tool: AnyTool) =>
  tool.placeholder === undefined ? undefined : tOr(k(tool.id, 'placeholder'), tool.placeholder);
export const optionLabel = (tool: AnyTool, key: string, spec: OptionSpec) =>
  tOr(k(tool.id, 'options', key, 'label'), spec.label);
export const optionHint = (tool: AnyTool, key: string, spec: OptionSpec) =>
  spec.hint === undefined ? undefined : tOr(k(tool.id, 'options', key, 'hint'), spec.hint);
export const optionPlaceholder = (tool: AnyTool, key: string, spec: OptionSpec) =>
  spec.type === 'text' && spec.placeholder !== undefined
    ? tOr(k(tool.id, 'options', key, 'placeholder'), spec.placeholder)
    : undefined;
export const choiceLabel = (tool: AnyTool, key: string, value: string, label: string) =>
  tOr(k(tool.id, 'options', key, 'choices', value), label);
export const exampleLabel = (tool: AnyTool, label: string) =>
  tOr(k(tool.id, 'examples', slug(label)), label);

const cat = (id: Category) => CATEGORIES.find((c) => c.id === id);
export const categoryName = (id: Category) => tOr(`cat.${id}.name`, cat(id)?.name ?? id);
export const categoryBlurb = (id: Category) => tOr(`cat.${id}.blurb`, cat(id)?.blurb ?? '');

/** Every derived key of a tool with its English text (used by the extract/check scripts). */
export function toolDefaultStrings(tool: AnyTool): Record<string, string> {
  const out: Record<string, string> = {
    [k(tool.id, 'name')]: tool.name,
    [k(tool.id, 'description')]: tool.description,
  };
  if (tool.placeholder !== undefined) out[k(tool.id, 'placeholder')] = tool.placeholder;
  for (const [key, spec] of Object.entries(tool.options ?? {})) {
    out[k(tool.id, 'options', key, 'label')] = spec.label;
    if (spec.hint !== undefined) out[k(tool.id, 'options', key, 'hint')] = spec.hint;
    if (spec.type === 'text' && spec.placeholder !== undefined) {
      out[k(tool.id, 'options', key, 'placeholder')] = spec.placeholder;
    }
    if (spec.type === 'select') {
      for (const c of spec.choices) out[k(tool.id, 'options', key, 'choices', c.value)] = c.label;
    }
  }
  for (const ex of tool.examples) out[k(tool.id, 'examples', slug(ex.label))] = ex.label;
  return out;
}

export function categoryDefaultStrings(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of CATEGORIES) {
    out[`cat.${c.id}.name`] = c.name;
    out[`cat.${c.id}.blurb`] = c.blurb;
  }
  return out;
}
