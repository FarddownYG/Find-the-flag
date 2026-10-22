import { describe, expect, it } from 'vitest';
import { defaultOptions } from '../../core/registry';
import { resultToText } from '../../core/result-text';
import type { ToolResult } from '../../core/types';
import { analyze, type VulnClass } from './_php-analyze';
import tool from './php-audit';

// The tool runs synchronously; the union return type just needs a narrow.
const run = (text: string): ToolResult =>
  tool.run(text, defaultOptions(tool as never) as never) as ToolResult;
const render = (text: string): string => resultToText(run(text));
const classes = (text: string): VulnClass[] => analyze(text).findings.map((f) => f.cls);
const find = (text: string, cls: VulnClass) => analyze(text).findings.find((f) => f.cls === cls);

describe('source → sink taint tracking', () => {
  it('reports LFI through a concatenated variable with the full path', () => {
    const src = "<?php $page = $_GET['page']; include($page . '.php');";
    const f = find(src, 'lfi')!;
    expect(f.severity).toBe('P0');
    expect(f.confidence).toBe('verified');
    expect(f.sink).toBe('include');
    expect(f.path).toBe("$_GET['page'] → $page → include()");
    expect(f.extra).toContain('rfi');
  });

  it('reports LFI when the source is used directly in the sink', () => {
    expect(classes("<?php include $_GET['p'];")).toContain('lfi');
  });

  it('reports SQL injection built by concatenation', () => {
    const src = "<?php $id = $_POST['id']; mysqli_query($db, 'SELECT * FROM u WHERE id=' . $id);";
    const f = find(src, 'sqli')!;
    expect(f.severity).toBe('P0');
    expect(f.path).toContain("$_POST['id']");
  });

  it('reports a SQL injection on a method call ($db->query)', () => {
    expect(classes("<?php $x->query('SELECT ' . $_GET['c']);")).toContain('sqli');
  });

  it('reports command injection, including in backticks', () => {
    expect(classes("<?php system('ls ' . $_GET['d']);")).toContain('cmd');
    expect(classes('<?php $o = `ping $_GET[h]`;')).toContain('cmd');
  });

  it('reports eval of input as code injection', () => {
    expect(classes("<?php eval($_GET['x']);")).toContain('code');
  });
});

describe('refuting false positives (adequate control present)', () => {
  it('does not report an include guarded by a strict whitelist', () => {
    const src = [
      '<?php',
      "$p = $_GET['page'];",
      "if (in_array($p, ['a', 'b'], true)) { include $p . '.php'; }",
    ].join('\n');
    expect(classes(src)).not.toContain('lfi');
    expect(analyze(src).safe.some((s) => s.sink === 'include')).toBe(true);
  });

  it('does not report an include wrapped in basename()', () => {
    expect(classes("<?php include basename($_GET['p']) . '.php';")).not.toContain('lfi');
  });

  it('treats an (int) cast as clean for every context', () => {
    expect(classes("<?php $id = (int) $_GET['id']; mysqli_query($db, 'WHERE id=' . $id);")).toEqual(
      [],
    );
  });

  it('does not report a prepared statement', () => {
    const src = [
      '<?php',
      "$id = $_GET['id'];",
      "$s = $pdo->prepare('SELECT * FROM u WHERE id = ?');",
      '$s->execute([$id]);',
    ].join('\n');
    expect(classes(src)).toEqual([]);
  });

  it('flags a weak sanitiser (addslashes) as only "to confirm"', () => {
    const f = find("<?php mysqli_query($db, 'x=' . addslashes($_GET['a']));", 'sqli')!;
    expect(f.confidence).toBe('review');
  });

  it('clears taint when a variable is re-assigned to a constant', () => {
    const src = "<?php $x = $_GET['a']; $x = 'static'; include $x . '.php';";
    expect(classes(src)).not.toContain('lfi');
  });
});

describe('type juggling and magic hashes', () => {
  it('reports a 0e magic-hash comparison with high confidence', () => {
    const f = find("<?php if (md5($_GET['p']) == '0e12345678901234567890') {}", 'juggle')!;
    expect(f.severity).toBe('P1');
    expect(f.confidence).toBe('verified');
    expect(f.extra).toBe('0e');
  });

  it('reports a loose comparison of a hash digest', () => {
    const f = find('<?php if (sha1($a) == $known) {}', 'juggle')!;
    expect(f.confidence).toBe('review');
  });

  it('reports in_array without the strict third argument', () => {
    expect(classes('<?php if (in_array($role, $admins)) {}')).toContain('juggle');
  });

  it('reports strcmp used as a boolean', () => {
    expect(classes("<?php if (strcmp($_POST['p'], $pw) == 0) {}")).toContain('juggle');
  });
});

describe('unserialize / object injection', () => {
  it('reports unserialize of input and surfaces magic methods', () => {
    const src = [
      '<?php',
      'class A { function __wakeup() {} function __destruct() {} }',
      "$o = unserialize($_COOKIE['data']);",
    ].join('\n');
    const a = analyze(src);
    expect(a.findings.some((f) => f.cls === 'unserialize')).toBe(true);
    expect(a.magicMethods).toEqual(expect.arrayContaining(['__wakeup', '__destruct']));
    expect(render(src)).toContain('POP chain');
  });

  it('does not report unserialize with allowed_classes', () => {
    const src = "<?php unserialize($_POST['d'], ['allowed_classes' => false]);";
    expect(classes(src)).not.toContain('unserialize');
  });
});

describe('other rules', () => {
  it('reports extract() of a request array', () => {
    expect(classes('<?php extract($_GET);')).toContain('code');
  });

  it('reports a preg_replace /e modifier', () => {
    const f = find("<?php preg_replace('/(.*)/e', 'strtoupper(\"$1\")', $_GET['x']);", 'code')!;
    expect(f.extra).toBe('php7');
  });

  it('reports weak randomness', () => {
    expect(classes('<?php $token = md5(uniqid());')).toContain('rand');
  });

  it('reports dangerous php.ini directives pasted in', () => {
    const f = find('allow_url_include = On\ndisplay_errors = On', 'config')!;
    expect(f.severity).toBe('P1');
  });

  it('reports a version banner and the PHP2Shell advisory without a PoC', () => {
    const out = render('<?php // X-Powered-By: PHP/5.6.40\n');
    expect(out).toContain('PHP 5.6.40');
    expect(out).toContain('PHP2Shell');
    expect(out).toContain('No proof of concept');
  });
});

describe('framing and non-PHP input', () => {
  it('says plainly that the pass is static', () => {
    expect(render("<?php echo $_GET['x'];")).toContain('100% static');
  });

  it('reports a clean file with no false positives', () => {
    const src = [
      '<?php',
      "$id = (int) $_GET['id'];",
      "$s = $pdo->prepare('SELECT * FROM u WHERE id = ?');",
      '$s->execute([$id]);',
    ].join('\n');
    expect(analyze(src).findings).toEqual([]);
    expect(render(src)).toContain('No source');
  });

  it('declines input that is not PHP', () => {
    const out = render('just some prose, nothing to see here at all');
    expect(out).toContain('does not look like PHP');
  });
});

describe('examples', () => {
  it('each example output contains its expect string', () => {
    for (const ex of tool.examples) {
      const input = typeof ex.input === 'string' ? ex.input : '';
      expect(render(input), ex.label).toContain(ex.expect);
    }
  });
});
