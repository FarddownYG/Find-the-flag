/** Markdown writeup builder: callers pass already-localized headings and bodies. */

export interface WriteupSection {
  heading: string;
  body: string;
}

export interface WriteupOptions {
  /** Document title (rendered as a level-1 heading). */
  title?: string;
  flag?: string;
  /** The flag line appears only when this is true; otherwise the flag is masked in every section. */
  includeFlag?: boolean;
  /** Label of the flag line. */
  flagLabel?: string;
}

/** Escape what would break a Markdown table cell. */
const cell = (s: string) => s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/** A Markdown table; every row is padded or cut to the header width. */
export function mdTable(headers: string[], rows: (string | number)[][]): string {
  if (!headers.length || !rows.length) return '';
  const line = (cells: (string | number)[]) =>
    `| ${headers.map((_, i) => cell(String(cells[i] ?? ''))).join(' | ')} |`;
  return [line(headers), line(headers.map(() => '---')), ...rows.map(line)].join('\n');
}

/** A two-column Markdown table from key/value pairs. */
export function kvTable(entries: [string, string][], headers: [string, string] = ['', '']): string {
  return mdTable(headers, entries);
}

/** A fenced code block whose fence is always longer than any backtick run inside. */
export function codeBlock(lang: string, text: string): string {
  const runs = text.match(/`+/g) ?? [];
  const fence = '`'.repeat(Math.max(3, ...runs.map((r) => r.length + 1)));
  return `${fence}${lang}\n${text.replace(/\n+$/, '')}\n${fence}`;
}

/** Masks the flag wherever it appears in a section when the writeup must not reveal it. */
export const FLAG_MASK = '<flag>';

/** Sections as `## heading` + body, an optional `# title` and, only when opted in, the flag. */
export function buildWriteup(sections: WriteupSection[], opts: WriteupOptions = {}): string {
  const parts: string[] = [];
  if (opts.title) parts.push(`# ${opts.title.trim()}`);
  const hide = (text: string) =>
    opts.flag && !opts.includeFlag ? text.split(opts.flag).join(FLAG_MASK) : text;
  for (const s of sections) {
    const body = hide(s.body).trim();
    parts.push(body ? `## ${s.heading.trim()}\n\n${body}` : `## ${s.heading.trim()}`);
  }
  if (opts.includeFlag && opts.flag) {
    const label = opts.flagLabel ?? 'Flag';
    parts.push(`**${label}:** \`${opts.flag.replace(/`/g, "'")}\``);
  }
  return `${parts.join('\n\n')}\n`;
}
