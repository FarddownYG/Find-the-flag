import { defineTool } from '../../core/define';
import { toolT } from '../../i18n/tool-text';
import { analyze } from './_php-analyze';
import { buildReport } from './_php-report';

const T = toolT('php-audit');

// A small, home-made vulnerable file (no challenge material): LFI by concatenation + a magic-hash
// comparison + an unescaped SQL query + a shell call.
const DEMO_VULN = [
  '<?php',
  "$page = $_GET['page'];",
  'include($page . ".php");            // LFI: no whitelist, no basename',
  '',
  'if (md5($_GET[\'p\']) == "0e462097431906509019562988736854") {',
  '  echo "secret area";               // == with a 0e hash: type juggling',
  '}',
  '',
  "$id = $_GET['id'];",
  '$db->query("SELECT * FROM users WHERE id = " . $id);  // SQLi: concatenation',
  'system("ping -c1 " . $_POST[\'host\']);               // command injection',
  '',
].join('\n');

// A clean version of the same features: whitelist, cast, prepared statement, escaping.
const DEMO_CLEAN = [
  '<?php',
  "$allowed = ['home', 'about', 'contact'];",
  "$page = $_GET['page'];",
  'if (in_array($page, $allowed, true)) {',
  '  include(__DIR__ . "/pages/" . $page . ".php");   // guarded by a strict whitelist',
  '}',
  '',
  "$id = (int) $_GET['id'];                            // cast to int",
  '$stmt = $pdo->prepare("SELECT * FROM users WHERE id = ?");',
  '$stmt->execute([$id]);                              // prepared statement',
  "echo htmlspecialchars($_GET['name']);              // escaped for HTML",
  '',
].join('\n');

const SUPERGLOBAL = /\$_(GET|POST|REQUEST|COOKIE|FILES|SERVER|ENV)\b|\$GLOBALS\b/;
const SINK =
  /\b(include|require|eval|system|exec|shell_exec|passthru|unserialize|mysqli?_query|preg_replace)\b/;

export default defineTool({
  id: 'php-audit',
  name: 'PHP vulnerability auditor (source → sink)',
  category: 'forensics',
  description:
    'Paste PHP source (yours, or one dumped over an LFI) and get its exploitable flaws: where attacker input enters, where it lands, and what sits between. 100% static — nothing is run or contacted.',
  tags: [
    'php',
    'lfi',
    'rfi',
    'sqli',
    'sql injection',
    'command injection',
    'rce',
    'code injection',
    'type juggling',
    'magic hash',
    'unserialize',
    'deserialization',
    'pop chain',
    'object injection',
    'ssrf',
    'source to sink',
    'taint',
    'sink',
    'audit',
    'static analysis',
    'webshell',
    'php filter',
    'php://filter',
    'eval',
    'preg_replace',
    'extract',
    'vulnerability',
    'faille',
    'injection',
    'sast',
  ],
  input: 'text',
  placeholder:
    'Paste PHP source here. To read a remote file first, dump it over an LFI with php://filter (base64), decode it, then paste it.',
  examples: [
    {
      label: 'Vulnerable file: LFI + type juggling + SQLi + command injection',
      input: DEMO_VULN,
      expect: 'File inclusion',
    },
    {
      label: 'The magic-hash comparison alone',
      input: "<?php if (md5($_GET['p']) == '0e123456789012345678901234567890') { echo 'ok'; }",
      expect: 'Type juggling',
    },
    {
      label: 'Clean version: whitelist, cast, prepared statement, escaping',
      input: DEMO_CLEAN,
      expect: 'No source',
    },
  ],
  detect({ text }) {
    if (!text || text.length < 8) return null;
    const looksPhp = /<\?(php|=)/.test(text);
    if (!looksPhp && !SUPERGLOBAL.test(text)) return null;
    if (SUPERGLOBAL.test(text) && SINK.test(text))
      return { score: 0.7, reason: T('detect.reason') };
    if (looksPhp) return { score: 0.4, reason: T('detect.php') };
    return null;
  },
  run(input) {
    return buildReport(analyze(input));
  },
});
