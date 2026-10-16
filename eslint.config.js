import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // public/samples holds the data the "Try" buttons load (some are .js files made to look like
    // real minified bundles); Prettier skips it too (.prettierignore).
    ignores: [
      'dist',
      'node_modules',
      'coverage',
      'playwright-report',
      'test-results',
      'public/samples',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: false }],
      // Tool output is untrusted data: never feed it to innerHTML.
      'no-restricted-properties': [
        'error',
        { property: 'innerHTML', message: 'Use textContent / h() — tool data is untrusted.' },
        { property: 'outerHTML', message: 'Use textContent / h() — tool data is untrusted.' },
      ],
    },
  },
);
