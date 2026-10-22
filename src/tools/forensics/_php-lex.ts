/**
 * A small PHP lexer for the static vulnerability analyzer. It is NOT a full parser: it turns PHP
 * source into tokens with line numbers, drops comments, keeps string contents (and the variables
 * interpolated inside double-quoted / heredoc strings and backticks), and tracks the `<?php … ?>`
 * tag mode so inline HTML is ignored except for the `<?=` echo shortcut. Enough for source→sink
 * taint tracking and pattern rules; its limits are stated on the tool's page.
 */

export interface PhpString {
  /** The raw inner text of the literal (no surrounding quotes, escapes left as written). */
  content: string;
  /** Double-quoted, heredoc and backticks interpolate variables; single-quoted / nowdoc do not. */
  interp: boolean;
  /** Names of the variables interpolated inside, when interp is true (e.g. ["id","page"]). */
  vars: string[];
}

export type Token =
  | { kind: 'var'; name: string; line: number }
  | { kind: 'id'; name: string; lower: string; line: number }
  | { kind: 'str'; str: PhpString; line: number }
  | { kind: 'num'; value: string; line: number }
  | { kind: 'op'; value: string; line: number }
  | { kind: 'punc'; value: string; line: number }
  | { kind: 'backtick'; str: PhpString; line: number };

const NAME_START = /[A-Za-z_\x80-\xff]/;
const NAME_CHAR = /[A-Za-z0-9_\x80-\xff]/;
const OPS = [
  '===',
  '!==',
  '<=>',
  '**=',
  '...',
  '<<=',
  '>>=',
  '??=',
  '==',
  '!=',
  '<>',
  '<=',
  '>=',
  '&&',
  '||',
  '->',
  '=>',
  '::',
  '++',
  '--',
  '+=',
  '-=',
  '*=',
  '/=',
  '.=',
  '%=',
  '&=',
  '|=',
  '^=',
  '<<',
  '>>',
  '**',
  '??',
  '?->',
];
const PUNC = new Set(['(', ')', '{', '}', '[', ']', ',', ';']);

/** Variables interpolated in a double-quoted / heredoc / backtick body: $name, ${name}, {$name…}. */
function interpVars(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(/(?<!\\)\$\{?([A-Za-z_\x80-\xff][A-Za-z0-9_\x80-\xff]*)/g)) {
    out.add(m[1]!);
  }
  for (const m of body.matchAll(/\{\$([A-Za-z_\x80-\xff][A-Za-z0-9_\x80-\xff]*)/g)) out.add(m[1]!);
  return [...out];
}

export function lexPhp(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let inPhp = false;
  const n = src.length;
  const adv = (s: string) => {
    for (let k = 0; k < s.length; k++) if (s[k] === '\n') line++;
    i += s.length;
  };

  while (i < n) {
    const c = src[i]!;
    if (!inPhp) {
      // Inline HTML: skip to the next opening tag.
      const open = src.indexOf('<?', i);
      if (open === -1) {
        adv(src.slice(i));
        break;
      }
      adv(src.slice(i, open));
      if (src.startsWith('<?php', i)) adv('<?php');
      else if (src.startsWith('<?=', i)) {
        adv('<?=');
        tokens.push({ kind: 'id', name: 'echo', lower: 'echo', line });
      } else adv('<?');
      inPhp = true;
      continue;
    }
    if (c === '\n' || c === ' ' || c === '\t' || c === '\r') {
      adv(c);
      continue;
    }
    if (src.startsWith('?>', i)) {
      // A close tag acts as an implicit ';'.
      tokens.push({ kind: 'punc', value: ';', line });
      adv('?>');
      inPhp = false;
      continue;
    }
    // Comments.
    if (src.startsWith('//', i) || c === '#') {
      let j = i;
      while (j < n && src[j] !== '\n' && !src.startsWith('?>', j)) j++;
      adv(src.slice(i, j));
      continue;
    }
    if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2);
      adv(src.slice(i, end === -1 ? n : end + 2));
      continue;
    }
    // Strings.
    if (c === "'" || c === '"') {
      const q = c;
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === q) break;
        j++;
      }
      const body = src.slice(i + 1, j);
      tokens.push({
        kind: 'str',
        str: { content: body, interp: q === '"', vars: q === '"' ? interpVars(body) : [] },
        line,
      });
      adv(src.slice(i, Math.min(j + 1, n)));
      continue;
    }
    if (c === '`') {
      let j = i + 1;
      while (j < n && src[j] !== '`') {
        if (src[j] === '\\') j++;
        j++;
      }
      const body = src.slice(i + 1, j);
      tokens.push({
        kind: 'backtick',
        str: { content: body, interp: true, vars: interpVars(body) },
        line,
      });
      adv(src.slice(i, Math.min(j + 1, n)));
      continue;
    }
    // Heredoc / nowdoc.
    if (src.startsWith('<<<', i)) {
      const m = /^<<<[ \t]*(['"]?)([A-Za-z_\x80-\xff][A-Za-z0-9_\x80-\xff]*)\1\r?\n/.exec(
        src.slice(i),
      );
      if (m) {
        const nowdoc = m[1] === "'";
        const label = m[2]!;
        const startBody = i + m[0].length;
        // The closing label is at the start of a line (optionally indented in PHP 7.3+).
        const end = new RegExp(`\\n[ \\t]*${label}\\b`).exec(src.slice(startBody));
        const bodyEnd = end ? startBody + end.index : n;
        const body = src.slice(startBody, bodyEnd);
        tokens.push({
          kind: 'str',
          str: { content: body, interp: !nowdoc, vars: nowdoc ? [] : interpVars(body) },
          line,
        });
        const closeLen = end
          ? end[0].length + label.length - (end[0].endsWith(label) ? label.length : 0)
          : 0;
        adv(src.slice(i, bodyEnd + (end ? end[0].length : 0)));
        void closeLen;
        continue;
      }
    }
    // Numbers.
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^(0[xX][0-9a-fA-F_]+|0[bB][01_]+|[0-9_]*\.?[0-9_]+([eE][+-]?[0-9]+)?)/.exec(
        src.slice(i),
      );
      const v = m ? m[0] : c;
      tokens.push({ kind: 'num', value: v, line });
      adv(v);
      continue;
    }
    // Variables.
    if (c === '$' && NAME_START.test(src[i + 1] ?? '')) {
      let j = i + 1;
      while (j < n && NAME_CHAR.test(src[j]!)) j++;
      tokens.push({ kind: 'var', name: src.slice(i + 1, j), line });
      adv(src.slice(i, j));
      continue;
    }
    // Identifiers / keywords.
    if (NAME_START.test(c)) {
      let j = i;
      while (j < n && NAME_CHAR.test(src[j]!)) j++;
      const name = src.slice(i, j);
      tokens.push({ kind: 'id', name, lower: name.toLowerCase(), line });
      adv(name);
      continue;
    }
    if (PUNC.has(c)) {
      tokens.push({ kind: 'punc', value: c, line });
      adv(c);
      continue;
    }
    // Operators (longest first).
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) {
      tokens.push({ kind: 'op', value: op, line });
      adv(op);
      continue;
    }
    // Any other single char (operator-ish): keep it so expression scanning stays aligned.
    tokens.push({ kind: 'op', value: c, line });
    adv(c);
  }
  return tokens;
}
