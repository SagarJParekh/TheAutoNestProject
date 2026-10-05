import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const isTest = !!process.env.VITEST;
const stub = fileURLToPath(new URL('./src/stubs/empty.ts', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    // rhino3dm's Emscripten glue references `ws` for Node pthreads; it is never loaded in browsers
    alias: isTest ? {} : { ws: stub },
  },
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    // WASM packages are loaded lazily inside workers; keep them out of the prebundle
    exclude: ['manifold-3d'],
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 60000,
  },
});
