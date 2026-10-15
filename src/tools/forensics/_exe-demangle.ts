/**
 * Demangling of C++ symbol names (Itanium ABI, as used by GCC and Clang) and of the legacy Rust
 * scheme, which is the same grammar with a hash. This is a subset on purpose: it covers nested
 * and template names, operators, constructors, special names, the usual types and substitutions.
 * Anything else (expressions, packs, decltype...) makes `demangle` return null and the caller
 * shows the mangled name, so the output is either right or absent.
 */

class Unsupported extends Error {}

const no = (): never => {
  throw new Unsupported();
};

abstract class Node {
  /** The node this one stands for (a template parameter stands for its argument). */
  resolved(): Node {
    return this;
  }
  abstract left(): string;
  right(): string {
    return '';
  }
  text(): string {
    return this.left() + this.right();
  }
}

/**
 * Substitutions can make a short name expand to something enormous; printing stops (and the
 * name is shown mangled) once this many characters have been produced.
 */
const OUTPUT_LIMIT = 100_000;
let outputLeft = OUTPUT_LIMIT;

class Lit extends Node {
  constructor(readonly s: string) {
    super();
  }
  left(): string {
    outputLeft -= this.s.length + 1;
    if (outputLeft < 0) no();
    return this.s;
  }
}

/** Something that can be the prefix of ctor / dtor names and knows its own short name. */
class Named extends Lit {
  constructor(
    s: string,
    readonly short: string = s,
  ) {
    super(s);
  }
}

class Scoped extends Node {
  constructor(
    readonly prefix: Node,
    readonly name: Node,
  ) {
    super();
  }
  left(): string {
    return `${this.prefix.text()}::${this.name.text()}`;
  }
}

/** An argument pack (J ... E): its items are spliced into the enclosing list. */
class Pack extends Node {
  constructor(readonly items: Node[]) {
    super();
  }
  left(): string {
    return flatten(this.items)
      .map((a) => a.text())
      .join(', ');
  }
}

function flatten(nodes: Node[]): Node[] {
  return nodes.flatMap((n) => (n instanceof Pack ? flatten(n.items) : [n]));
}

function argList(args: Node[]): string {
  const parts = flatten(args)
    .map((a) => a.text())
    .filter((a) => a !== '');
  const s = parts.join(', ');
  // libiberty puts a space between two closing brackets, except when the list ends with an
  // empty pack (it removes the ", " it had written but still sees the space).
  const last = args[args.length - 1];
  const endsEmpty = args.length > 1 && last !== undefined && last.text() === '';
  return `<${s}${s.endsWith('>') && !endsEmpty ? ' ' : ''}>`;
}

class Templated extends Node {
  constructor(
    readonly name: Node,
    readonly args: Node[],
  ) {
    super();
  }
  left(): string {
    const name = this.name.text();
    // "operator<" followed by "<" would read as "operator<<".
    return name + (name.endsWith('<') ? ' ' : '') + argList(this.args);
  }
}

class Qual extends Node {
  constructor(
    readonly inner: Node,
    readonly cv: string,
  ) {
    super();
  }
  /**
   * The same qualifiers applied once: duplicates collapse (a `const` parameter bound to a
   * const type), and on an array they belong to the elements.
   */
  private shape(): { base: Node; cv: string } | { array: Arr } {
    const words = new Set(this.cv.split(' '));
    let base = this.inner.resolved();
    while (base instanceof Qual) {
      for (const w of base.cv.split(' ')) words.add(w);
      base = base.inner.resolved();
    }
    const cv = ['restrict', 'volatile', 'const'].filter((w) => words.has(w)).join(' ');
    if (base instanceof Arr) return { array: new Arr(new Qual(base.elem, cv), base.dim) };
    return { base: base === this.inner.resolved() ? this.inner : base, cv };
  }
  /** A qualifier on a pointer goes right after the star, even for a pointer to function. */
  private onPointer(base: Node): boolean {
    return base instanceof Ptr || base instanceof MemberPtr || !base.right();
  }
  left(): string {
    const sh = this.shape();
    if ('array' in sh) return sh.array.left();
    return sh.base.left() + (this.onPointer(sh.base) ? ` ${sh.cv}` : '');
  }
  override right(): string {
    const sh = this.shape();
    if ('array' in sh) return sh.array.right();
    return sh.base.right() + (this.onPointer(sh.base) ? '' : ` ${sh.cv}`);
  }
}

class Ptr extends Node {
  constructor(
    readonly inner: Node,
    readonly sym: string,
  ) {
    super();
  }
  /** A reference to a reference (reached through a template parameter) collapses to one. */
  private shape(): { inner: Node; sym: string } {
    if (this.sym.startsWith('&')) {
      const r = this.inner.resolved();
      if (r instanceof Ptr && r.sym.startsWith('&')) {
        const c = r.shape();
        return { inner: c.inner, sym: this.sym === '&' || c.sym === '&' ? '&' : '&&' };
      }
    }
    return { inner: this.inner, sym: this.sym };
  }
  /** Only a function or an array needs brackets around the star: `void (*)()`, `int (&)[3]`. */
  private opensBracket(inner: Node): boolean {
    let base = inner.resolved();
    while (base instanceof Qual) base = base.inner.resolved();
    return base instanceof Fn || base instanceof Arr;
  }
  left(): string {
    const { inner, sym } = this.shape();
    return this.opensBracket(inner) ? `${inner.left()} (${sym}` : `${inner.left()}${sym}`;
  }
  override right(): string {
    const { inner } = this.shape();
    return this.opensBracket(inner) ? `)${inner.right()}` : inner.right();
  }
}

class Fn extends Node {
  constructor(
    readonly ret: Node | null,
    readonly params: Node[],
    readonly cv = '',
  ) {
    super();
  }
  left(): string {
    return this.ret ? this.ret.text() : '';
  }
  override text(): string {
    return `${this.left()}${this.ret ? ' ' : ''}${this.right()}`;
  }
  override right(): string {
    const params = flatten(this.params)
      .map((p) => p.text())
      .filter((p) => p !== '');
    const ps = params.length === 1 && params[0] === 'void' ? '' : params.join(', ');
    return `(${ps})${this.cv ? ` ${this.cv}` : ''}`;
  }
}

class Arr extends Node {
  constructor(
    readonly elem: Node,
    readonly dim: string,
  ) {
    super();
  }
  left(): string {
    return this.elem.left();
  }
  override right(): string {
    return ` [${this.dim}]${this.elem.right()}`;
  }
}

/**
 * The template arguments of the function being printed. A template parameter (T_, T0_...) is
 * looked up here when it is printed, not when it is parsed: a substitution made inside one
 * function's signature and reused in another's stands for that function's own arguments.
 */
let printArgs: Node[] | null = null;

function withArgs<T>(args: Node[] | null, fn: () => T): T {
  const saved = printArgs;
  printArgs = args;
  try {
    return fn();
  } finally {
    printArgs = saved;
  }
}

/** While a pack expansion (Dp) is printed: first measure the pack, then print it element by element. */
let packContext: { mode: 'probe'; len: number | null } | { mode: 'emit'; index: number } | null =
  null;

class TParam extends Node {
  constructor(readonly n: number) {
    super();
  }
  private target(): Node {
    const arg = printArgs?.[this.n] ?? no();
    if (arg instanceof Pack && packContext) {
      if (packContext.mode === 'probe') {
        packContext.len = arg.items.length;
        return new Lit('');
      }
      return arg.items[packContext.index] ?? no();
    }
    return arg;
  }
  override resolved(): Node {
    return this.target().resolved();
  }
  left(): string {
    return this.target().left();
  }
  override right(): string {
    return this.target().right();
  }
}

/** Dp <type>: the pattern, repeated once for each element of the pack it mentions. */
class PackExpansion extends Node {
  constructor(readonly pattern: Node) {
    super();
  }
  left(): string {
    const saved = packContext;
    try {
      const probe: { mode: 'probe'; len: number | null } = { mode: 'probe', len: null };
      packContext = probe;
      this.pattern.text();
      if (probe.len === null) no();
      const parts: string[] = [];
      for (let i = 0; i < probe.len!; i++) {
        packContext = { mode: 'emit', index: i };
        parts.push(this.pattern.text());
      }
      return parts.join(', ');
    } finally {
      packContext = saved;
    }
  }
}

const BUILTIN: Record<string, string> = {
  v: 'void',
  w: 'wchar_t',
  b: 'bool',
  c: 'char',
  a: 'signed char',
  h: 'unsigned char',
  s: 'short',
  t: 'unsigned short',
  i: 'int',
  j: 'unsigned int',
  l: 'long',
  m: 'unsigned long',
  x: 'long long',
  y: 'unsigned long long',
  n: '__int128',
  o: 'unsigned __int128',
  f: 'float',
  d: 'double',
  e: 'long double',
  g: '__float128',
  z: '...',
};

const OPERATORS: Record<string, string> = {
  nw: 'new',
  na: 'new[]',
  dl: 'delete',
  da: 'delete[]',
  ps: '+',
  ng: '-',
  ad: '&',
  de: '*',
  co: '~',
  pl: '+',
  mi: '-',
  ml: '*',
  dv: '/',
  rm: '%',
  an: '&',
  or: '|',
  eo: '^',
  aS: '=',
  pL: '+=',
  mI: '-=',
  mL: '*=',
  dV: '/=',
  rM: '%=',
  aN: '&=',
  oR: '|=',
  eO: '^=',
  ls: '<<',
  rs: '>>',
  lS: '<<=',
  rS: '>>=',
  eq: '==',
  ne: '!=',
  lt: '<',
  gt: '>',
  le: '<=',
  ge: '>=',
  ss: '<=>',
  nt: '!',
  aa: '&&',
  oo: '||',
  pp: '++',
  mm: '--',
  cm: ',',
  pm: '->*',
  pt: '->',
  cl: '()',
  ix: '[]',
  qu: '?',
};

const STD = new Named('std');
/**
 * The abbreviations of the standard library. Like `c++filt` (which runs libiberty in verbose
 * mode) the string and stream classes are written out in full.
 */
const STD_NAMES: Record<string, () => Node> = {
  a: () => new Scoped(STD, new Named('allocator')),
  b: () => new Scoped(STD, new Named('basic_string')),
  s: () =>
    new Named(
      'std::basic_string<char, std::char_traits<char>, std::allocator<char> >',
      'basic_string',
    ),
  i: () => new Named('std::basic_istream<char, std::char_traits<char> >', 'basic_istream'),
  o: () => new Named('std::basic_ostream<char, std::char_traits<char> >', 'basic_ostream'),
  d: () => new Named('std::basic_iostream<char, std::char_traits<char> >', 'basic_iostream'),
};

const MAX_DEPTH = 64;

class Parser {
  private p = 0;
  private depth = 0;
  private readonly subs: Node[] = [];
  /** Name of the last class component seen, for constructors and destructors. */
  private lastName = '';

  constructor(private readonly s: string) {}

  done(): boolean {
    return this.p >= this.s.length;
  }
  private peek(o = 0): string {
    return this.s[this.p + o] ?? '';
  }
  private eat(c: string): boolean {
    if (this.s.startsWith(c, this.p)) {
      this.p += c.length;
      return true;
    }
    return false;
  }
  private need(c: string): void {
    if (!this.eat(c)) no();
  }
  private enter(): void {
    if (++this.depth > MAX_DEPTH) no();
  }
  private leave(): void {
    this.depth--;
  }

  private number(): number {
    const start = this.p;
    while (/[0-9]/.test(this.peek())) this.p++;
    if (this.p === start || this.p - start > 8) no();
    return Number(this.s.slice(start, this.p));
  }

  private sourceName(): Node {
    const n = this.number();
    if (this.p + n > this.s.length || n === 0) no();
    const id = this.s.slice(this.p, this.p + n);
    this.p += n;
    this.lastName = id;
    return new Named(id.startsWith('_GLOBAL__N') ? '(anonymous namespace)' : id);
  }

  /** <mangled-name> ::= _Z <encoding> */
  parse(): string {
    this.need('_Z');
    return this.encoding(true).text();
  }

  private special(): Node | null {
    const two = this.s.slice(this.p, this.p + 2);
    const prefixes: Record<string, string> = {
      TV: 'vtable for ',
      TT: 'VTT for ',
      TI: 'typeinfo for ',
      TS: 'typeinfo name for ',
      GV: 'guard variable for ',
      GR: 'reference temporary #0 for ',
      TH: 'TLS init function for ',
      TW: 'TLS wrapper function for ',
    };
    const text = prefixes[two];
    if (text !== undefined) {
      this.p += 2;
      if (two === 'GV' || two === 'GR' || two === 'TH' || two === 'TW') {
        return new Lit(text + this.name().text());
      }
      return new Lit(text + this.type().text());
    }
    if (two === 'Th' || two === 'Tv') {
      this.p += 2;
      let what = 'non-virtual thunk to ';
      if (two === 'Th') this.offset();
      else {
        what = 'virtual thunk to ';
        this.offset();
        this.need('_');
        this.offset();
      }
      return new Lit(what + this.encoding(false).text());
    }
    return null;
  }

  private offset(): void {
    this.eat('n');
    if (this.peek() === '_') no();
    this.number();
    this.need('_');
  }

  private encoding(top: boolean): Node {
    this.enter();
    try {
      const sp = this.special();
      if (sp) return sp;
      this.ctorLike = false;
      this.conversion = false;
      this.fnCv = '';
      const name = this.name();
      const ctorLike = this.ctorLike;
      const conversion = this.conversion;
      const cv = this.fnCv;
      this.fnCv = '';
      const more = !this.done() && this.peek() !== 'E';
      if (!more) return name;
      const types: Node[] = [];
      while (!this.done() && this.peek() !== 'E') types.push(this.type());
      // A template function that is not a constructor, destructor or conversion encodes its
      // return type first.
      let ret: Node | null = null;
      if (name instanceof Templated && !ctorLike && !conversion) ret = types.shift() ?? no();
      return new Encoded(name, new Fn(ret, types, cv), !top && this.inLocal > 0 ? false : true);
    } finally {
      this.leave();
    }
  }

  private fnCv = '';
  private ctorLike = false;
  private conversion = false;

  /** <name> */
  private name(): Node {
    this.enter();
    try {
      const c = this.peek();
      if (c === 'N') return this.nested();
      if (c === 'Z') return this.local();
      if (c === 'S' && this.peek(1) !== 't') {
        const sub = this.substitution();
        if (this.peek() === 'I') {
          const args = this.templateArgs();
          return new Templated(sub, args);
        }
        return sub;
      }
      let base: Node;
      if (this.eat('St')) base = new Scoped(STD, this.unqualified(null));
      else base = this.unqualified(null);
      if (this.peek() === 'I') {
        this.subs.push(base);
        const args = this.templateArgs();
        return new Templated(base, args);
      }
      return base;
    } finally {
      this.leave();
    }
  }

  private inLocal = 0;

  private local(): Node {
    this.need('Z');
    this.inLocal++;
    const fn = this.encoding(false);
    this.inLocal--;
    this.need('E');
    let entity: Node;
    if (this.eat('s')) entity = new Lit('string literal');
    else entity = this.name();
    if (this.eat('_')) {
      // discriminator
      if (this.eat('_')) {
        this.number();
        this.need('_');
      } else if (/[0-9]/.test(this.peek())) this.p++;
    }
    return new Scoped(fn, entity);
  }

  private cvQuals(): string {
    let cv = '';
    if (this.eat('r')) cv += ' restrict';
    if (this.eat('V')) cv += ' volatile';
    if (this.eat('K')) cv += ' const';
    return cv.trim();
  }

  private nested(): Node {
    this.need('N');
    const cv = this.cvQuals();
    if (this.eat('R')) this.fnCv += '&';
    else if (this.eat('O')) this.fnCv += '&&';
    let prefix: Node | null = null;
    for (;;) {
      if (this.eat('E')) break;
      const c = this.peek();
      let part: Node;
      if (c === 'S') {
        if (this.eat('St')) {
          prefix = STD;
          continue;
        }
        const ab = this.peek(1);
        if (!(ab in STD_NAMES || ab === '_' || /[0-9A-Z]/.test(ab))) no();
        prefix = this.substitution();
        continue;
      } else if (c === 'I') {
        if (prefix === null) no();
        const args = this.templateArgs();
        prefix = new Templated(prefix!, args);
        if (this.peek() !== 'E') this.subs.push(prefix);
        continue;
      } else if (c === 'T') {
        prefix = this.templateParam();
        this.subs.push(prefix);
        continue;
      } else part = this.unqualified(prefix);
      prefix = prefix === null ? part : new Scoped(prefix, part);
      if (this.peek() !== 'E') this.subs.push(prefix);
    }
    if (prefix === null) no();
    if (cv) this.fnCv = (cv + (this.fnCv ? ` ${this.fnCv}` : '')).trim();
    return prefix!;
  }

  /** <unqualified-name>, with `scope` giving the class for constructors and destructors. */
  private unqualified(scope: Node | null): Node {
    const c = this.peek();
    let node: Node;
    if (/[0-9]/.test(c)) node = this.sourceName();
    else if (c === 'C' && /[1-5]/.test(this.peek(1))) {
      this.p += 2;
      this.ctorLike = true;
      node = new Lit(this.className(scope));
    } else if (c === 'D' && /[0-5]/.test(this.peek(1))) {
      this.p += 2;
      this.ctorLike = true;
      node = new Lit(`~${this.className(scope)}`);
    } else if (c === 'U' && this.peek(1) === 't') {
      this.p += 2;
      const n = /[0-9]/.test(this.peek()) ? this.number() + 1 : 0;
      this.need('_');
      node = new Lit(`{unnamed type#${n + 1}}`);
    } else if (c === 'U' && this.peek(1) === 'l') {
      this.p += 2;
      const params: Node[] = [];
      while (this.peek() !== 'E') params.push(this.type());
      this.need('E');
      const n = /[0-9]/.test(this.peek()) ? this.number() + 1 : 0;
      this.need('_');
      const list = params.map((x) => x.text());
      node = new Lit(
        `{lambda(${list.length === 1 && list[0] === 'void' ? '' : list.join(', ')})#${n + 1}}`,
      );
    } else if (c === 'c' && this.peek(1) === 'v') {
      this.p += 2;
      this.conversion = true;
      node = new Lit(`operator ${this.type().text()}`);
    } else if (c === 'l' && this.peek(1) === 'i') {
      this.p += 2;
      node = new Lit(`operator"" ${this.sourceName().text()}`);
    } else {
      const op = OPERATORS[this.s.slice(this.p, this.p + 2)];
      if (op === undefined) no();
      this.p += 2;
      node = new Lit(`operator${/^[a-z]/.test(op!) ? ' ' : ''}${op}`);
    }
    // ABI tags: B <source-name>
    while (this.peek() === 'B') {
      this.p++;
      const short = node instanceof Named ? node.short : node.text();
      const tag = this.sourceName().text();
      node = new Named(`${node.text()}[abi:${tag}]`, short);
    }
    return node;
  }

  private className(scope: Node | null): string {
    if (scope instanceof Named) return scope.short;
    if (scope instanceof Scoped && scope.name instanceof Named) return scope.name.short;
    if (scope instanceof Templated) return this.className(scope.name);
    if (scope instanceof Scoped) return this.className(scope.name);
    return this.lastName || no();
  }

  private substitution(): Node {
    this.need('S');
    const c = this.peek();
    if (c in STD_NAMES && c !== '') {
      this.p++;
      const n = STD_NAMES[c]!();
      return n;
    }
    let seq = 0;
    if (c !== '_') {
      let n = 0;
      let count = 0;
      while (/[0-9A-Z]/.test(this.peek())) {
        const d = this.s.charCodeAt(this.p);
        n = n * 36 + (d <= 57 ? d - 48 : d - 55);
        this.p++;
        if (++count > 6) no();
      }
      seq = n + 1;
    }
    this.need('_');
    const sub = this.subs[seq];
    if (!sub) no();
    return sub!;
  }

  private templateParam(): Node {
    this.need('T');
    let n = 0;
    if (this.peek() !== '_') n = this.number() + 1;
    this.need('_');
    return new TParam(n);
  }

  private templateArgs(): Node[] {
    this.need('I');
    const args: Node[] = [];
    while (this.peek() !== 'E') args.push(this.templateArg());
    this.need('E');
    return args;
  }

  private templateArg(): Node {
    const c = this.peek();
    if (c === 'L') return this.literal();
    if (c === 'X') no();
    if (c === 'J') {
      this.p++;
      const items: Node[] = [];
      while (this.peek() !== 'E') items.push(this.templateArg());
      this.need('E');
      return new Pack(items);
    }
    return this.type();
  }

  private literal(): Node {
    this.need('L');
    if (this.peek() === '_' && this.peek(1) === 'Z') no();
    const t = this.type();
    const neg = this.eat('n');
    const start = this.p;
    while (/[0-9a-f]/.test(this.peek())) this.p++;
    const v = this.s.slice(start, this.p);
    this.need('E');
    if (v === '') no();
    const num = `${neg ? '-' : ''}${v}`;
    switch (t.text()) {
      case 'int':
        return new Lit(num);
      case 'unsigned int':
        return new Lit(`${num}u`);
      case 'long':
        return new Lit(`${num}l`);
      case 'unsigned long':
        return new Lit(`${num}ul`);
      case 'long long':
        return new Lit(`${num}ll`);
      case 'unsigned long long':
        return new Lit(`${num}ull`);
      case 'bool':
        return new Lit(v === '0' ? 'false' : 'true');
      default:
        return new Lit(`(${t.text()})${num}`);
    }
  }

  /** <type> */
  type(): Node {
    this.enter();
    try {
      const c = this.peek();
      const b = BUILTIN[c];
      if (b !== undefined && c !== '') {
        this.p++;
        return new Lit(b);
      }
      let node: Node;
      switch (c) {
        case 'r':
        case 'V':
        case 'K': {
          const cv = this.cvQuals();
          const inner = this.type();
          if (inner instanceof Fn) {
            // c++filt counts the qualified function type once, not the bare one as well.
            if (this.subs[this.subs.length - 1] === inner) this.subs.pop();
            node = new Fn(inner.ret, inner.params, [inner.cv, cv].filter(Boolean).join(' '));
          } else if (inner instanceof Arr) node = new Arr(new Qual(inner.elem, cv), inner.dim);
          else node = new Qual(inner, cv);
          break;
        }
        case 'P':
          this.p++;
          node = new Ptr(this.type(), '*');
          break;
        case 'R':
        case 'O':
          this.p++;
          node = new Ptr(this.type(), c === 'R' ? '&' : '&&');
          break;
        case 'F': {
          this.p++;
          this.eat('Y');
          const ret = this.type();
          const params: Node[] = [];
          let cv = '';
          while (this.peek() !== 'E') {
            if (this.peek() === 'R' && this.peek(1) === 'E') {
              this.p++;
              cv = '&';
              continue;
            }
            params.push(this.type());
          }
          this.need('E');
          node = new Fn(ret, params, cv);
          break;
        }
        case 'A': {
          this.p++;
          const dim = /[0-9]/.test(this.peek()) ? String(this.number()) : '';
          this.need('_');
          node = new Arr(this.type(), dim);
          break;
        }
        case 'T': {
          node = this.templateParam();
          this.subs.push(node);
          if (this.peek() === 'I') {
            const args = this.templateArgs();
            node = new Templated(node, args);
            this.subs.push(node);
          }
          return node;
        }
        case 'S': {
          if (this.peek(1) === 't') {
            node = this.name();
            this.subs.push(node);
            return node;
          }
          const sub = this.substitution();
          if (this.peek() === 'I') {
            const args = this.templateArgs();
            node = new Templated(sub, args);
            this.subs.push(node);
            return node;
          }
          return sub;
        }
        case 'D': {
          const d = this.peek(1);
          if (d === 'n') {
            this.p += 2;
            return new Lit('decltype(nullptr)');
          }
          if (d === 'a') {
            this.p += 2;
            return new Lit('auto');
          }
          if (d === 'i') {
            this.p += 2;
            return new Lit('char32_t');
          }
          if (d === 's') {
            this.p += 2;
            return new Lit('char16_t');
          }
          if (d === 'u') {
            this.p += 2;
            return new Lit('char8_t');
          }
          if (d === 'h') {
            this.p += 2;
            return new Lit('half');
          }
          if (d === 'p') {
            this.p += 2;
            node = new PackExpansion(this.type());
            break;
          }
          return no();
        }
        case 'M': {
          this.p++;
          const cls = this.type();
          const member = this.type();
          if (member instanceof Fn) {
            node = new MemberPtr(member, cls, true);
          } else node = new MemberPtr(member, cls, false);
          break;
        }
        case 'N':
        case 'Z':
        case '0':
        case '1':
        case '2':
        case '3':
        case '4':
        case '5':
        case '6':
        case '7':
        case '8':
        case '9': {
          node = this.name();
          this.subs.push(node);
          return node;
        }
        case 'u':
          return no();
        default:
          return no();
      }
      this.subs.push(node);
      return node;
    } finally {
      this.leave();
    }
  }
}

/** Pointer to member (data or function). */
class MemberPtr extends Node {
  constructor(
    readonly member: Node,
    readonly cls: Node,
    readonly isFn: boolean,
  ) {
    super();
  }
  left(): string {
    if (this.member instanceof Fn) {
      return `${this.member.left()} (${this.cls.text()}::*`;
    }
    return `${this.member.left()} ${this.cls.text()}::*`;
  }
  override right(): string {
    return this.member instanceof Fn ? `)${this.member.right()}` : this.member.right();
  }
}

/** An encoding: its (possibly scoped) name followed by the parameter list. */
class Encoded extends Node {
  constructor(
    readonly name: Node,
    readonly fn: Fn,
    /** The return type of a template function is left out inside a local name. */
    readonly showReturn = true,
  ) {
    super();
  }
  private args(): Node[] | null {
    return this.name instanceof Templated ? this.name.args : printArgs;
  }
  left(): string {
    return withArgs(
      this.args(),
      () => (this.fn.ret && this.showReturn ? `${this.fn.ret.text()} ` : '') + this.name.text(),
    );
  }
  override right(): string {
    return withArgs(this.args(), () => this.fn.right());
  }
}

const RUST_ESCAPES: [string, string][] = [
  ['$SP$', '@'],
  ['$BP$', '*'],
  ['$RF$', '&'],
  ['$LT$', '<'],
  ['$GT$', '>'],
  ['$LP$', '('],
  ['$RP$', ')'],
  ['$C$', ','],
  ['$u20$', ' '],
  ['$u27$', "'"],
  ['$u5b$', '['],
  ['$u5d$', ']'],
  ['$u7b$', '{'],
  ['$u7d$', '}'],
  ['$u3b$', ';'],
  ['$u2b$', '+'],
  ['$u22$', '"'],
];

/** Legacy Rust symbols: _ZN + length-prefixed parts + a 17h<16 hex> hash + E. */
function rustLegacy(name: string): string | null {
  if (!name.startsWith('_ZN') || !name.endsWith('E')) return null;
  const parts: string[] = [];
  let p = 3;
  while (p < name.length - 1) {
    const m = /^(\d+)/.exec(name.slice(p));
    if (!m) return null;
    const n = Number(m[1]);
    const start = p + m[1]!.length;
    if (start + n > name.length - 1) return null;
    parts.push(name.slice(start, start + n));
    p = start + n;
  }
  const last = parts[parts.length - 1];
  if (parts.length < 2 || last === undefined || !/^h[0-9a-f]{16}$/.test(last)) return null;
  parts.pop();
  return parts
    .map((part) => {
      let s = part.startsWith('_$') ? part.slice(1) : part;
      for (const [from, to] of RUST_ESCAPES) s = s.split(from).join(to);
      return s.replace(/\.\./g, '::');
    })
    .join('::');
}

/** The readable form of a mangled name, or null when it is not mangled or not supported. */
export function demangle(name: string): string | null {
  if (name.length < 3 || name[0] !== '_') return null;
  const rust = rustLegacy(name);
  if (rust !== null) return rust;
  if (!name.startsWith('_Z')) return null;
  // Compiler clones (.part.0, .isra.1, .cold) follow the mangled name after a dot.
  const dot = name.indexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const suffix = dot > 0 ? name.slice(dot) : '';
  if (base.length > 4096) return null;
  outputLeft = OUTPUT_LIMIT;
  try {
    const parser = new Parser(base);
    const out = parser.parse();
    if (!parser.done()) return null;
    return suffix ? `${out} [clone ${suffix}]` : out;
  } catch (e) {
    if (e instanceof Unsupported) return null;
    throw e;
  }
}
