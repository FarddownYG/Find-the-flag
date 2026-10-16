/**
 * The Web source analyzer's sample files, written by scripts/gen-samples-web-source.mjs into
 * public/samples/ and re-built by the tests, which check that the committed bytes are exactly
 * these. Everything is made up: a pretend "demo-shop" web app whose bundle, source map and
 * secrets exist only here. The secrets are plain test words, not credentials of anything.
 *
 *  web-source-bundle.js       a webpack-style bundle that ends with a sourceMappingURL comment
 *  web-source-bundle.js.map   its map. One source, pages/Admin/SecretPanel.js, is imported by
 *                             nothing (its route is commented out in router.js): the bundle does
 *                             not show it, only the map's sourcesContent does
 *  web-source-inline.js       a script whose source map is inlined as a base64 data: URI
 */
import { toBase64, utf8Encode } from '../../lib/bytes';

/** The words the samples hide, for the tests and the "Try" examples. */
export const BUNDLE_SECRET = 'TEST_FLAG_123';
export const INLINE_SECRET = 'INLINE_SECRET_456';
export const HIDDEN_FILE = 'webpack://demo-shop/./src/pages/Admin/SecretPanel.js';

interface Source {
  path: string;
  /** null: the map names the file but does not carry it. */
  content: string | null;
}

export const BUNDLE_SOURCES: Source[] = [
  {
    path: 'webpack://demo-shop/./src/index.js',
    content: [
      "import { createRouter } from './router';",
      "import App from './App';",
      '',
      'const router = createRouter();',
      "console.log('demo-shop started', router.routes);",
      'export default App;',
      '',
    ].join('\n'),
  },
  {
    path: 'webpack://demo-shop/./src/App.js',
    content: [
      "import Home from './pages/Home';",
      '',
      'export default function App() {',
      '  return Home();',
      '}',
      '',
    ].join('\n'),
  },
  {
    path: 'webpack://demo-shop/./src/router.js',
    content: [
      "import Home from './pages/Home';",
      "// import SecretPanel from './pages/Admin/SecretPanel';",
      '',
      'export function createRouter() {',
      '  const routes = {',
      "    '/': Home,",
      "    // '/admin-panel': SecretPanel, // disabled before the release: no link points here any more",
      '  };',
      '  return { routes };',
      '}',
      '',
    ].join('\n'),
  },
  {
    path: 'webpack://demo-shop/./src/pages/Home.js',
    content: ['export default function Home() {', "  return 'home page';", '}', ''].join('\n'),
  },
  {
    path: HIDDEN_FILE,
    content: [
      '// Hidden admin panel. The route is commented out in router.js, so no page reaches this file.',
      `// secret: ${BUNDLE_SECRET}`,
      'export default function SecretPanel() {',
      "  return 'admin only';",
      '}',
      '',
    ].join('\n'),
  },
  {
    path: 'webpack://demo-shop/./node_modules/tiny-lib/index.js',
    content: 'module.exports = function tiny(a, b) {\n  return a + b;\n};\n',
  },
  { path: 'webpack://demo-shop/external "tiny-ui"', content: null },
];

/** A source map, version 3. The mappings are a stub: reading the sources does not need them. */
function mapOf(file: string, sources: Source[], root = ''): Record<string, unknown> {
  return {
    version: 3,
    file,
    sourceRoot: root,
    sources: sources.map((s) => s.path),
    sourcesContent: sources.map((s) => s.content),
    names: [],
    mappings: 'AAAA;AACA',
  };
}

export function bundleMap(): Record<string, unknown> {
  return mapOf('web-source-bundle.js', BUNDLE_SOURCES);
}

export function buildBundle(): string {
  return [
    '/*! demo-shop bundle (made-up sample file) */',
    '(()=>{"use strict";var e={417:(e,t,n)=>{n.r(t),n.d(t,{default:()=>o});var r=n(902);function o(){return"home: "+(0,r.greet)("visitor")}},902:(e,t,n)=>{n.r(t),n.d(t,{greet:()=>r});function r(e){return"hello "+e}}},t={};function n(r){var o=t[r];if(void 0!==o)return o.exports;var a=t[r]={exports:{}};return e[r](a,a.exports,n),a.exports}n.d=(e,t)=>{for(var r in t)n.o(t,r)&&!n.o(e,r)&&Object.defineProperty(e,r,{enumerable:!0,get:t[r]})},n.o=(e,t)=>Object.prototype.hasOwnProperty.call(e,t),n.r=e=>{"undefined"!=typeof Symbol&&Symbol.toStringTag&&Object.defineProperty(e,Symbol.toStringTag,{value:"Module"}),Object.defineProperty(e,"__esModule",{value:!0})};const r={"/":n(417).default};console.log("demo-shop started",Object.keys(r))})();',
    '//# sourceMappingURL=web-source-bundle.js.map',
    '',
  ].join('\n');
}

export function buildBundleMapJson(): string {
  return JSON.stringify(bundleMap());
}

const INLINE_SOURCES: Source[] = [
  {
    path: 'webpack:///./src/config.js',
    content: `export const adminPassword = '${INLINE_SECRET}';\nexport const retries = 3;\n`,
  },
  {
    path: 'webpack:///./src/loader.js',
    content:
      "import { retries } from './config';\nexport function load() {\n  return retries;\n}\n",
  },
];

export function inlineMap(): Record<string, unknown> {
  return mapOf('web-source-inline.js', INLINE_SOURCES);
}

export function buildInline(): string {
  const map = utf8Encode(JSON.stringify(inlineMap()));
  return [
    '/*! settings loader (made-up sample file) */',
    '(function(){var c={name:"demo",retries:3};window.__demoConfig=c})();',
    `//# sourceMappingURL=data:application/json;charset=utf-8;base64,${toBase64(map)}`,
    '',
  ].join('\n');
}

export function buildSamples(): { name: string; bytes: Uint8Array }[] {
  return [
    { name: 'web-source-bundle.js', bytes: utf8Encode(buildBundle()) },
    { name: 'web-source-bundle.js.map', bytes: utf8Encode(buildBundleMapJson()) },
    { name: 'web-source-inline.js', bytes: utf8Encode(buildInline()) },
  ];
}
