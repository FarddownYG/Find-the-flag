import { CATEGORIES, type AnyTool } from './types';

/**
 * Auto-discovery: every file under src/tools/ whose default export is a tool is registered.
 * Files named *.test.ts or _*.ts (private helpers) are skipped. Nothing else to edit.
 */
const modules = import.meta.glob<{ default: AnyTool }>(
  ['../tools/**/*.ts', '!../tools/**/*.test.ts', '!../tools/**/_*.ts'],
  { eager: true },
);

export function validateTools(entries: [string, AnyTool | undefined][]): string[] {
  const errors: string[] = [];
  const seen = new Map<string, string>();
  const cats = new Set(CATEGORIES.map((c) => c.id));
  for (const [path, t] of entries) {
    if (!t || typeof t.run !== 'function') {
      errors.push(`${path}: no default-exported tool (use export default defineTool({...})).`);
      continue;
    }
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(t.id))
      errors.push(`${path}: id "${t.id}" must be kebab-case.`);
    const prev = seen.get(t.id);
    if (prev) errors.push(`${path}: duplicate id "${t.id}" (also in ${prev}).`);
    seen.set(t.id, path);
    if (!cats.has(t.category)) errors.push(`${path}: unknown category "${t.category}".`);
    if (!t.examples?.length) errors.push(`${path}: at least one example is required.`);
  }
  return errors;
}

const entries = Object.entries(modules).map(([p, m]) => [p, m.default] as [string, AnyTool]);
const problems = validateTools(entries);
if (problems.length) throw new Error(`Tool registry is invalid:\n${problems.join('\n')}`);

const order = new Map(CATEGORIES.map((c, i) => [c.id, i]));

export const TOOLS: readonly AnyTool[] = entries
  .map(([, t]) => t)
  .sort((a, b) => order.get(a.category)! - order.get(b.category)! || a.name.localeCompare(b.name));

const byId = new Map(TOOLS.map((t) => [t.id, t]));
export const getTool = (id: string): AnyTool | undefined => byId.get(id);

export function defaultOptions(tool: AnyTool): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, spec] of Object.entries(tool.options ?? {})) out[k] = spec.default;
  return out;
}
