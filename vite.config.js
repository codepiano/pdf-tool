import { defineConfig } from 'vite';

export default defineConfig({
  // MuPDF's WASM initializer uses top-level await, including in the worker.
  build: { target: 'esnext' },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['mupdf'] },
});
