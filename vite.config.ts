import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative base: the build works from any static host or sub-path (GitHub Pages, IPFS, file share).
  base: './',
  // No data: URIs: small font subsets would otherwise be inlined, which the strict CSP
  // (font-src 'self') rightly refuses.
  build: { target: 'es2022', sourcemap: false, assetsInlineLimit: 0 },
  worker: { format: 'es' },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // The registry is an import.meta.glob: a cached transform would hide newly added tools.
    fsModuleCache: false,
  },
});
