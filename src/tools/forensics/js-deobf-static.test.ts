import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { beautify } from './_js-deobf-beautify';
import { lex, quoteJs } from './_js-deobf-lex';
import { MAX_ROUNDS, atobPrintable, decodeJsString, peel, type PeelRule } from './_js-deobf-static';

const BS = String.fromCharCode(92);
/** The text of the literal as the JavaScript engine itself reads it: the independent reference. */
const engine = (body: string, quote = '"'): string =>
  runInNewContext(`${quote}${body}${quote}`) as string;
/** What an expression gives, read by the engine. */
const value = (code: string): unknown => runInNewContext(code, { x: 1 });
const rules = (code: string): PeelRule[] =>
  peel(code).rounds.flatMap((r) => r.steps.map((s) => s.rule));

describe('decodeJsString agrees with the JavaScript engine', () => {
  const bodies = [
    'plain',
    `${BS}x41${BS}x42`,
    `${BS}u0041${BS}u00e9`,
    `${BS}u{1F600}${BS}u{41}`,
    `${BS}ud83d${BS}ude00`, // a surrogate pair written as two escapes
    `${BS}141${BS}75${BS}160`, // octal, a=p
    `${BS}7${BS}0${BS}08${BS}101${BS}1018`,
    `${BS}377${BS}400`, // \377 is one escape, \400 is \40 and then 0
    `${BS}n${BS}t${BS}r${BS}b${BS}f${BS}v`,
    `${BS}${BS}${BS}"${BS}'`,
    `${BS}8${BS}9${BS}q${BS}/${BS}d`,
    `a${BS}${BS}x41`, // an escaped backslash, then plain x41
    `${BS}x41${BS}${BS}u0042`,
  ];
  it.each(bodies)('%s', (body) => {
    expect(decodeJsString(body)).toBe(engine(body));
  });

  it('a line continuation disappears', () => {
    expect(decodeJsString(`a${BS}\nb`)).toBe('ab');
    expect(decodeJsString(`a${BS}\r\nb`)).toBe('ab');
  });

  it('an invalid or lossy literal is refused, not guessed', () => {
    for (const body of [
      `${BS}x4`,
      `${BS}u12`,
      `${BS}u{110000}`,
      `${BS}u{}`,
      `abc${BS}`,
      `${BS}ud800`,
    ]) {
      expect(decodeJsString(body), body).toBeNull();
    }
  });
});

describe('quoteJs', () => {
  it('writes a string the engine reads back as the same string', () => {
    const exotic = String.fromCharCode(0xe9, 0x2713, 0x2028, 0x2029, 0xfeff, 0xd800);
    const samples = [
      'plain',
      `it's "quoted"`,
      'tab\tnew\nline\r',
      `back${BS}slash`,
      exotic,
      '\x00\x01\x7f',
    ];
    for (const s of samples) {
      for (const q of ['"', "'"] as const) expect(runInNewContext(quoteJs(s, q))).toBe(s);
    }
  });
});

describe('the lexer', () => {
  const kinds = (src: string) =>
    lex(src)
      .filter((t) => t.kind !== 'ws')
      .map((t) => `${t.kind}:${src.slice(t.start, t.end)}`);

  it('keeps strings, templates, comments and regular expressions whole', () => {
    expect(kinds(`a = "x'y" + 'z"w' // c "no"`)).toEqual([
      'word:a',
      'punct:=',
      `string:"x'y"`,
      'punct:+',
      `string:'z"w'`,
      'comment:// c "no"',
    ]);
    expect(kinds('`a${"}"}b` /* "c" */')).toEqual(['template:`a${"}"}b`', 'comment:/* "c" */']);
    expect(kinds('x = a / b / c; y = /a\\/b[/]/g.test(z)')).toEqual([
      'word:x',
      'punct:=',
      'word:a',
      'punct:/',
      'word:b',
      'punct:/',
      'word:c',
      'punct:;',
      'word:y',
      'punct:=',
      'regex:/a\\/b[/]/g',
      'punct:.',
      'word:test',
      'punct:(',
      'word:z',
      'punct:)',
    ]);
  });

  it('covers its input completely and in order', () => {
    const src = 'var a = `t${1}`;\n/* c */ if (a) { return /r/.test("s") } else x++ + ++y // end';
    const toks = lex(src);
    expect(toks.map((t) => src.slice(t.start, t.end)).join('')).toBe(src);
  });

  it('an unterminated string stops at the end of the line', () => {
    const toks = lex('"abc\nnext');
    expect(toks[0]).toMatchObject({ kind: 'string', bad: true });
    expect(toks.some((t) => t.kind === 'word')).toBe(true);
  });
});

describe('peel: the rules, one at a time', () => {
  it('decodes the escapes of a string literal, keeping its quote', () => {
    const r = peel(
      `var a = '${BS}x66${BS}x6c${BS}x61${BS}x67', b = "${BS}146${BS}154${BS}141${BS}147", c = "${BS}u{66}${BS}u006c";`,
    );
    expect(r.code).toBe(`var a = 'flag', b = "flag", c = "fl";`);
    expect(rules(r.code)).toEqual([]);
  });

  it('leaves the escapes that are not hidden, and the text of comments and templates', () => {
    const src = `// "${BS}x41"\nvar t = \`${BS}x41\${"${BS}x42"}\`; var r = /"${BS}x41"/; var s = "a${BS}nb";`;
    expect(peel(src).changed).toBe(false);
  });

  it('joins "a" + "b" and chains of them', () => {
    expect(peel(`var s = "fl" + 'ag' + "{" + "x" + "}";`).code).toBe(`var s = "flag{x}";`);
  });

  it('joins only where + is the whole operation (checked against the engine)', () => {
    const exprs = [
      `"a" + "b"`,
      `x + "a" + "b"`,
      `x + "a" + "b" + x`,
      `1 - "1" + "2"`,
      `-"1" + "2"`,
      `+"1" + "2"`,
      `!"a" + "b"`,
      `typeof "a" + "b"`,
      `"a" + "b" * 2`,
      `"a" + "b".length`,
      `"a" + "b" + "c" * 2`,
      `("a" + "b").length + "c" + "d"`,
      `["a" + "b"][0]`,
      `"3" * "a" + "b"`,
      `void 0 + "a" + "b"`,
      `"x" + "a" + "b" ** 2`,
      `x ? "a" + "b" : "c" + "d"`,
      `[x, "a" + "b", "c"].join("-")`,
      `"a" + "b" in { ab: 1 }`,
      `"1" + "2" - 1`,
      `"a".length + "b" + "c"`,
      `"a" + ("b" + "c")`,
    ];
    for (const e of exprs) {
      expect(value(peel(e).code), e).toBe(value(e));
    }
    expect(peel(`x + "a" + "b" + x`).code).toBe(`x + "ab" + x`);
    expect(peel(`-"1" + "2"`).code).toBe(`-"1" + "2"`);
    expect(peel(`"a" + "b" * 2`).code).toBe(`"a" + "b" * 2`);
    expect(peel(`typeof "a" + "b"`).code).toBe(`typeof "a" + "b"`);
  });

  it('replaces unescape and decodeURIComponent of a literal', () => {
    expect(peel(`unescape("%66%6c%u0061%67")`).code).toBe(`"flag"`);
    expect(peel(`window.unescape("%41")`).code).toBe(`"A"`);
    expect(peel(`decodeURIComponent("%E2%9C%93")`).code).toBe(`"${String.fromCharCode(0x2713)}"`);
    // not decodable the way the engine would: left alone
    expect(peel(`decodeURIComponent("%E0%A4%A")`).changed).toBe(false);
    expect(peel(`obj.unescape("%41")`).changed).toBe(false);
  });

  it('replaces String.fromCharCode of numbers, in every spelling', () => {
    expect(peel(`String.fromCharCode(102, 0x6c, 97, 103)`).code).toBe(`"flag"`);
    expect(peel(`String["fromCharCode"](70, 84, 70)`).code).toBe(`"FTF"`);
    expect(peel(`String.fromCharCode.apply(null, [72, 105])`).code).toBe(`"Hi"`);
    expect(peel(`String.fromCharCode(65 + 1)`).changed).toBe(false);
    expect(peel(`String.fromCharCode(x)`).changed).toBe(false);
    // The low 16 bits count: 65601 is 65 + 65536.
    expect(peel(`String.fromCharCode(65601)`).code).toBe(`"A"`);
    expect(peel(`String.fromCharCode(0xd83d, 0xde00)`).code).toBe(
      `"${String.fromCodePoint(0x1f600)}"`,
    );
  });

  it('replaces atob of printable text only', () => {
    expect(peel(`atob("ZmxhZw==")`).code).toBe(`"flag"`);
    expect(peel(`atob("ZmxhZw")`).code).toBe(`"flag"`);
    expect(peel(`atob("//79")`).changed).toBe(false); // bytes that are not text
    expect(peel(`atob("not base64!")`).changed).toBe(false);
    expect(atobPrintable('YQ===')).toBeNull();
    expect(atobPrintable('YQ')).toBe('a');
  });

  it('opens eval("…") and Function("…")() written as statements', () => {
    expect(peel(`eval("alert(1);");`).code).toBe(`alert(1);`);
    expect(peel(`var a = 1; eval("a++");`).code).toBe(`var a = 1; a++;`);
    expect(peel(`Function("alert(2)")();`).code).toBe(`alert(2);`);
    expect(peel(`new Function("alert(3)")()`).code).toBe(`alert(3)`);
    // not a statement, or it returns something: left as it is
    expect(peel(`var v = eval("1 + 1");`).changed).toBe(false);
    expect(peel(`f(eval("1"));`).changed).toBe(false);
    expect(peel(`Function("return 1")();`).changed).toBe(false);
    expect(peel(`x.eval("1");`).changed).toBe(false);
  });
});

describe('peel: layers', () => {
  const b64 = (s: string) => Buffer.from(s, 'latin1').toString('base64');
  const percent = (s: string) => [...s].map((c) => `%${c.charCodeAt(0).toString(16)}`).join('');

  it('peels eval(unescape(…)) around eval(atob(…)) round by round', () => {
    const payload = 'alert("FTF{layers}");';
    const src = `eval(unescape("${percent(`eval(atob("${b64(payload)}"));`)}"));`;
    const r = peel(src);
    expect(r.code).toBe(payload);
    expect(r.rounds.map((x) => x.steps.map((s) => s.rule))).toEqual([
      ['unescape', 'eval'],
      ['atob', 'eval'],
    ]);
    expect(r.stop).toBe('done');
  });

  it('a pass shows its code, and only the last one keeps it whole', () => {
    const long = 'x'.repeat(6000);
    let src = `var q = "${long}";`;
    for (let i = 0; i < 2; i++) src = `eval(atob("${b64(src)}"));`;
    const r = peel(src);
    expect(r.rounds.length).toBe(2);
    expect(r.rounds[0]!.code.length).toBeLessThanOrEqual(4000);
    expect(r.rounds[1]!.code).toBe(`var q = "${long}";`);
    expect(r.code).toBe(`var q = "${long}";`);
  });

  it('stops after the maximum number of passes and says so', () => {
    let src = 'alert(1);';
    for (let i = 0; i < MAX_ROUNDS + 5; i++) src = `eval(atob("${b64(src)}"));`;
    const r = peel(src);
    expect(r.stop).toBe('rounds');
    expect(r.rounds).toHaveLength(MAX_ROUNDS);
    expect(r.code.startsWith('eval(atob("')).toBe(true);
  });

  it('is idempotent: peeling the result changes nothing', () => {
    const src = `var a = "${BS}x41" + "b"; eval(unescape("%61%6c%65%72%74%28%31%29%3b"));`;
    const once = peel(src);
    expect(peel(once.code).changed).toBe(false);
  });

  it('never executes anything: a payload that would be seen stays text', () => {
    const src = `eval("globalThis.__peeled_ran = true;");`;
    const r = peel(src);
    expect(r.code).toBe('globalThis.__peeled_ran = true;');
    expect((globalThis as Record<string, unknown>)['__peeled_ran']).toBeUndefined();
  });
});

describe('peel: bounds', () => {
  it('a megabyte of escapes is peeled in one go', () => {
    const body = `${BS}x41`.repeat(250_000);
    const t0 = Date.now();
    const r = peel(`var s = "${body}";`);
    expect(r.code === `var s = "${'A'.repeat(250_000)}";`).toBe(true);
    expect(Date.now() - t0).toBeLessThan(8000);
  });

  it('a megabyte with nothing to peel is read quickly', () => {
    const src = 'a = b + c(d, [1, 2, 3]);\n'.repeat(40_000);
    const t0 = Date.now();
    expect(peel(src).changed).toBe(false);
    expect(Date.now() - t0).toBeLessThan(8000);
  });

  it('a pathological one-character-token text does not hang', () => {
    const src = '+'.repeat(1_000_000);
    const t0 = Date.now();
    peel(src);
    expect(Date.now() - t0).toBeLessThan(15_000);
  });
});

describe('beautify', () => {
  const tokens = (src: string) =>
    lex(src)
      .filter((t) => t.kind !== 'ws')
      .map((t) => src.slice(t.start, t.end));
  const corpus = [
    'function a(b,c){var d={x:1,y:[1,2,3],z:"s;t"};if(b){return c+1}else{for(var i=0;i<10;i++){d.x+=i}}return -d.x+ +c/2,typeof c==="x"?1:2}',
    'var f=function(){return/re;gex/.test("q")},g=a?.b??c;label:while(!0){break label}',
    'a=1\nb=2\n;(function(){})()\nc=a\n++b',
    'if(a)b();else if(c)d();else{e()}',
    'x=a+ +b-- -c;y=a- -b;z=a/b/c;w=1 .toString()',
    'try{f()}catch(e){g(e)}finally{h()}do{i++}while(i<3)',
    'var o={a:1,"b":2,get c(){return 3},[d]:4,e(){}},t=`x${a+b}y`',
    'switch(a){case 1:b();break;default:c()}',
    'var s="}{;";// }{;\n/* }{; */var r=/[}{;]/;',
    'a=b?c:d?e:f;g=h?i:j',
    'new Foo(a,b).bar(c)[d]=e;delete a.b;void 0;',
    'async function f(){await g();yield*h()}',
    'for(var k in o)if(o.hasOwnProperty(k))n++;for(const v of a){}',
  ];
  it.each(corpus)('keeps every token, and every line break: %s', (src) => {
    const out = beautify(src);
    expect(tokens(out)).toEqual(tokens(src));
    // A line break that was between two tokens is still there.
    const inSrc = lex(src);
    let breaks = 0;
    for (let i = 0; i < inSrc.length; i++) {
      if (inSrc[i]!.kind === 'ws' && inSrc[i]!.nl && i > 0 && i < inSrc.length - 1) breaks++;
    }
    expect(out.split('\n').length - 1).toBeGreaterThanOrEqual(breaks);
  });

  it('gives the same result when the code is run (checked against the engine)', () => {
    const programs = [
      'var n=0;for(var i=0;i<5;i++){n+=i}n',
      'function f(a,b){return a>b?a-b:b-a}f(3,10)+f(10,3)',
      'var a=1,b=2;a+ +b+(a-- -b)',
      'var o={x:1,y:[1,2,3]};o.y.map(function(v){return v*o.x}).join("-")',
      'var s="";for(var k in {a:1,b:2}){s+=k}s',
      'var x=5;if(x>3){x="big"}else{x="small"}x',
      '(function(){return 1})()+2',
      'var t=`a${1+1}b`,r=/b/.test(t);t+r',
    ];
    for (const p of programs) {
      expect(runInNewContext(beautify(p)), p).toEqual(runInNewContext(p));
    }
  });

  it('indents blocks and breaks after ; and braces', () => {
    expect(beautify('function a(b){if(b){return 1}return 2}')).toBe(
      ['function a(b) {', '  if (b) {', '    return 1', '  }', '  return 2', '}'].join('\n'),
    );
  });

  it('leaves a for(;;) header on one line and strings alone', () => {
    expect(beautify('for(var i=0;i<3;i++){f("a;b")}')).toBe(
      ['for (var i = 0; i < 3; i++) {', '  f("a;b")', '}'].join('\n'),
    );
  });

  it('is cheap on a megabyte', () => {
    const src = 'function f(a){return a+1}'.repeat(40_000);
    const t0 = Date.now();
    beautify(src);
    expect(Date.now() - t0).toBeLessThan(8000);
  });
});
