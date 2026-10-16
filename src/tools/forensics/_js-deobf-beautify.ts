/**
 * A small JavaScript re-indenter for the result of the peel. It only changes white space (outside
 * strings, templates, regular expressions and comments), and it never removes a line break that was
 * there, so a script that relies on automatic semicolon insertion reads the same. The tests check
 * that the tokens before and after are identical.
 */
import { lex } from './_js-deobf-lex';

/** Words that are followed by a space before ( or [ : `if (`, `return [`. */
const KEYWORDS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'with',
  'return',
  'typeof',
  'void',
  'delete',
  'await',
  'yield',
  'case',
  'throw',
  'in',
  'of',
  'instanceof',
  'new',
  'else',
  'do',
]);
/** After `}` these continue the same statement: no line break. */
const CONTINUES = new Set(['else', 'catch', 'finally', 'while', 'in', 'of', 'instanceof']);
const BINARY = new Set([
  '=',
  '==',
  '===',
  '!=',
  '!==',
  '<',
  '>',
  '<=',
  '>=',
  '+',
  '-',
  '*',
  '/',
  '%',
  '**',
  '&&',
  '||',
  '??',
  '&',
  '|',
  '^',
  '<<',
  '>>',
  '>>>',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '**=',
  '<<=',
  '>>=',
  '>>>=',
  '&=',
  '|=',
  '^=',
  '&&=',
  '||=',
  '??=',
  '=>',
]);
/** Two of these in a row would read as another token: keep a space between them. */
const STICKY = new Set(['++', '--', '//', '/*', '*/', '<!', '+-', '-+']);

interface Item {
  kind: string;
  text: string;
  /** A line break came before it in the source. */
  nl: boolean;
  /** A sign or a prefix operator (no space after it). */
  unary?: boolean;
}

/** Something a binary operator can follow: a value, or the end of a call or index. */
const endsOperand = (p: Item | null): boolean =>
  !!p &&
  (p.kind === 'word' ||
    p.kind === 'num' ||
    p.kind === 'string' ||
    p.kind === 'template' ||
    p.kind === 'regex' ||
    p.text === ')' ||
    p.text === ']');

export function beautify(src: string, indent = '  '): string {
  const items: Item[] = [];
  let nl = false;
  for (const t of lex(src)) {
    if (t.kind === 'ws') {
      if (t.nl) nl = true;
      continue;
    }
    items.push({ kind: t.kind, text: src.slice(t.start, t.end), nl });
    nl = false;
  }

  let out = '';
  let atLineStart = true;
  let depth = 0;
  let ternary = 0;
  const stack: string[] = [];
  let prev: Item | null = null;
  let spaceAfter = false;

  const newline = (): void => {
    if (!atLineStart) out += '\n';
    atLineStart = true;
  };
  const write = (text: string, space: boolean): void => {
    if (atLineStart) out += indent.repeat(depth);
    else if (space) out += ' ';
    out += text;
    atLineStart = false;
  };
  /** Is a space wanted between `prev` and the item `cur`? */
  const gap = (cur: Item): boolean => {
    if (atLineStart || !prev) return false;
    const t = cur.text;
    const punct = cur.kind === 'punct';
    // 1 .toString(): without the space the dot would become a decimal point.
    if (punct && t === '.' && prev.kind === 'num' && /^\d+$/.test(prev.text)) return true;
    if (punct && [')', ']', ',', ';', '.', '?.'].includes(t)) return false;
    if (prev.kind === 'comment') return true;
    if (prev.text === '}' && cur.kind === 'word') return true; // } else
    if (punct && (t === '++' || t === '--') && endsOperand(prev)) return false; // x++
    if (punct && t === '(') {
      if (prev.kind === 'word' && KEYWORDS.has(prev.text)) return true;
      return endsOperand(prev) ? false : spaceAfter;
    }
    if (punct && t === '[') {
      if (prev.kind === 'word' && KEYWORDS.has(prev.text)) return true;
      return endsOperand(prev) ? false : spaceAfter;
    }
    if (punct && t === '{') return prev.text !== '(' && prev.text !== '[';
    if (punct && BINARY.has(t) && !cur.unary) return true;
    if (punct && t === ':') return ternary > 0;
    if (!punct || cur.unary || t === '!' || t === '~' || t === '++' || t === '--' || t === '...') {
      // An operand or a prefix operator: after another operand it needs its own space.
      if (endsOperand(prev)) return true;
      return spaceAfter;
    }
    return spaceAfter;
  };
  const sticks = (cur: Item): boolean =>
    !!prev &&
    prev.kind === 'punct' &&
    cur.kind === 'punct' &&
    STICKY.has(prev.text[prev.text.length - 1]! + cur.text[0]!);

  const afterBrace = (following: Item | undefined): void => {
    if (!following) return;
    if (following.kind === 'punct') {
      if (following.text === '}' || following.text === '{') newline();
      return;
    }
    if (following.kind === 'word' && CONTINUES.has(following.text)) return;
    newline();
  };

  for (let i = 0; i < items.length; i++) {
    const cur = items[i]!;
    const next = items[i + 1];
    const t = cur.text;
    // A line break that was in the source stays one.
    if (cur.nl && !atLineStart) newline();

    if (cur.kind === 'comment') {
      write(t, gap(cur));
      prev = cur;
      spaceAfter = true;
      if (t.startsWith('//')) newline();
      continue;
    }

    if (cur.kind === 'punct') {
      if (t === '{') {
        const space = gap(cur);
        if (next?.kind === 'punct' && next.text === '}') {
          write('{}', space);
          prev = next;
          spaceAfter = false;
          i++;
          afterBrace(items[i + 1]);
          continue;
        }
        write('{', space);
        stack.push('{');
        depth++;
        newline();
        prev = cur;
        spaceAfter = false;
        continue;
      }
      if (t === '}') {
        if (stack[stack.length - 1] === '{') stack.pop();
        depth = Math.max(0, depth - 1);
        newline();
        write('}', false);
        prev = cur;
        spaceAfter = false;
        afterBrace(next);
        continue;
      }
      if (t === ';') {
        write(';', false);
        prev = cur;
        if (stack[stack.length - 1] === '(') spaceAfter = true;
        else {
          spaceAfter = false;
          newline();
        }
        continue;
      }
      if (t === '(' || t === '[') {
        write(t, gap(cur) || sticks(cur));
        stack.push(t);
      } else if (t === ')' || t === ']') {
        if (stack[stack.length - 1] === (t === ')' ? '(' : '[')) stack.pop();
        write(t, false);
      } else if (t === '?') {
        write('?', true);
        ternary++;
      } else if (t === ':') {
        const inTernary = ternary > 0;
        if (inTernary) ternary--;
        write(':', inTernary);
      } else {
        // + and - are signs after an operator or at the start of an expression.
        if ((t === '+' || t === '-') && (!prev || !endsOperand(prev))) {
          cur.unary = !(prev?.text === '}');
        }
        write(t, gap(cur) || sticks(cur));
      }
      prev = cur;
      const binary = BINARY.has(t) && !cur.unary;
      spaceAfter = binary || t === ',' || t === '?' || t === ':';
      continue;
    }

    // A word, number, string, template or regular expression.
    write(t, gap(cur) || (endsOperand(prev) && !atLineStart));
    prev = cur;
    spaceAfter = false;
  }

  return out.replace(/[ \t]+$/gm, '').replace(/\n+$/, '');
}
