import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative base: the build works from any static host or sub-path (GitHub Pages, IPFS, file share).
  base: './',
  build: { target: 'es2022', sourcemap: false },
  worker: { format: 'es' },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
