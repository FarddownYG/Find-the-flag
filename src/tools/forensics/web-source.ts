import { bool, defineTool, file, text, toggle } from '../../core/define';
import { toolT } from '../../i18n/tool-text';
import { toBase64, utf8Encode } from '../../lib/bytes';
import { isBareUrl } from './_web-source-fetch';
import { looksLikeMap } from './_web-source-map';
import { buildReport } from './_web-source-report';
import { analyze, classify } from './_web-source-run';

const T = toolT('web-source');

/** base64url, no padding, of a JSON text: the way a JWT part is written. */
const b64url = (json: string): string =>
  toBase64(utf8Encode(json)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// The "Try" inputs are made of pieces so that no secret scanner mistakes them for real keys.
const DEMO_JWT = [
  b64url('{"alg":"HS256","typ":"JWT"}'),
  b64url('{"user":"admin","role":"owner"}'),
  'c2lnbmF0dXJl',
].join('.');

const DEMO_SCRIPT = [
  '// demo script (made-up sample)',
  `const awsKey = '${'AKIA'}IOSFODNN7EXAMPLE';`,
  `const session = '${DEMO_JWT}';`,
  `const hint = atob('${toBase64(utf8Encode('FTF{base64_in_a_script}'))}');`,
  'const code = String.fromCharCode(70, 84, 70, 123, 99, 111, 100, 101, 125);',
  'function check(password) {',
  "  if (password === 'open-sesame') return true;",
  '  return false;',
  '}',
  '',
].join('\n');

const DEMO_PAGE = [
  '<!doctype html>',
  '<html>',
  '<head>',
  '  <title>Demo shop</title>',
  '  <link rel="stylesheet" href="/static/app.css">',
  '  <script src="/static/app.js"></script>',
  '</head>',
  '<body>',
  '  <!-- TODO remove before release: FTF{html_comment} -->',
  '  <img src="/img/logo.png" alt="">',
  '  <iframe src="/embed/help.html"></iframe>',
  '  <form action="/login" method="post">',
  '    <input type="hidden" name="session_token" value="d3m0-t0k3n-8841">',
  '    <input name="user"><input type="password" name="pass">',
  '  </form>',
  '  <script>',
  '    var adminPassword = "hunter2-demo";',
  "    if (document.getElementById('pw').value === 'letmein-demo') { go(); }",
  '  </script>',
  '</body>',
  '</html>',
  '',
].join('\n');

const isUrlMode = (v: Record<string, unknown>) => v.source === 'url';

export default defineTool({
  id: 'web-source',
  name: 'Web source analyzer (HTML / JS / source maps)',
  category: 'forensics',
  description:
    "Read a page's HTML, a JavaScript file or a source map the way DevTools does: files and comments, every original file inside sourcesContent, and a search for passwords, keys, tokens and flags.",
  tags: [
    'source map',
    'sourcemap',
    'sourceMappingURL',
    'sourcesContent',
    'webpack',
    'vite',
    'react',
    'js map',
    'view-source',
    'devtools',
    'html comments',
    'hidden field',
    'secrets',
    'secret scanner',
    'api key',
    'password',
    'token',
    'gitleaks',
    'trufflehog',
    'robots.txt',
    'client-side',
    'web',
    'javascript',
    'bundle',
    'minified',
  ],
  input: 'text',
  // A run in URL mode makes network requests: it only ever starts from the Run button.
  live: false,
  placeholder:
    'Paste a page (view-source), a JavaScript file or a .map (JSON). To fetch a page, type its URL and set Input to URL.',
  options: {
    source: toggle(
      'Input',
      [
        { value: 'auto', label: 'Auto' },
        { value: 'paste', label: 'Paste' },
        { value: 'url', label: 'URL' },
      ],
      'auto',
      {
        hint: 'Auto and Paste read what you pasted and never use the network; Auto offers URL mode when the text is only a URL. URL fetches that one address through a public proxy when you press Run: the proxy operator sees the URL and the page, a proxy can be down, rate-limited or refused by the target, and it returns the raw HTML, not the page after its scripts ran. Pasting (Ctrl+U, view-source:) is more reliable.',
      },
    ),
    map: file('Source map file (.map)', 'bytes', {
      hint: 'Optional: the .map that goes with the script you pasted (it names it in //# sourceMappingURL=). You can also paste the .map under the script, or alone as the input.',
    }),
    allorigins: bool('Proxy allorigins.win', true, { showIf: isUrlMode }),
    corsproxy: bool('Proxy corsproxy.io', true, { showIf: isUrlMode }),
    codetabs: bool('Proxy codetabs.com', true, { showIf: isUrlMode }),
    guess: bool('Also try <script>.map', true, {
      hint: 'A script without a //# sourceMappingURL comment may still have a map next to it: try the script address followed by .map.',
      showIf: isUrlMode,
    }),
    deps: bool('Scan dependencies too', false, {
      hint: 'Files under node_modules and bundler internals only get the strong checks (flags, key formats, JWT, private keys). Switch on to run every check on them too (noisy).',
    }),
    open: text('Open source files', '', {
      placeholder: '5 router admin',
      hint: 'Source map: show these files in full. A number from the table, or part of a path; separate several with spaces. Empty: the files with findings and the application files.',
    }),
    // Set by the "Fetch again" button; never shown.
    refresh: text('Fetch again counter', '', { showIf: () => false }),
  },
  examples: [
    {
      label: 'Bundle with its source map',
      input: { sample: 'web-source-bundle.js' },
      options: { map: { sample: 'web-source-bundle.js.map' } },
      expect: 'TEST_FLAG_123',
    },
    {
      label: 'Bundle alone, map not given',
      input: { sample: 'web-source-bundle.js' },
      expect: 'web-source-bundle.js.map',
    },
    {
      label: 'A .map file pasted',
      input: { sample: 'web-source-bundle.js.map' },
      expect: 'TEST_FLAG_123',
    },
    {
      label: 'Inline source map (data: URI)',
      input: { sample: 'web-source-inline.js' },
      expect: 'INLINE_SECRET_456',
    },
    {
      label: 'HTML page: links, comments, hidden field',
      input: DEMO_PAGE,
      expect: 'FTF{html_comment}',
    },
    {
      label: 'Secret hunter on a script',
      input: DEMO_SCRIPT,
      expect: 'FTF{base64_in_a_script}',
    },
    {
      label: 'A bare URL (nothing is fetched)',
      input: 'https://ctf.example.test/static/app.js',
      expect: 'nothing was requested',
    },
  ],
  detect({ text: sample }) {
    if (!sample || sample.length < 8) return null;
    if (looksLikeMap(sample)) return { score: 0.9, reason: T('detect.map') };
    if (/[#@]\s*sourceMappingURL=/.test(sample.slice(-4096))) {
      return { score: 0.85, reason: T('detect.mapRef') };
    }
    if (isBareUrl(sample)) return { score: 0.4, reason: T('detect.url') };
    const type = classify(sample.slice(0, 200_000));
    if (type === 'html') return { score: 0.6, reason: T('detect.html') };
    if (type === 'js' && sample.length > 400) return { score: 0.3, reason: T('detect.js') };
    return null;
  },
  async run(input, options) {
    return buildReport(await analyze(input, options), options);
  },
});
