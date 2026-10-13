import { defineConfig } from 'vite';

export default defineConfig({
  server: { host: '127.0.0.1', port: Number(process.env.PDF_TOOL_PORT ?? 4315), strictPort: true },
  // MuPDF's WASM initializer uses top-level await, including in the worker.
  build: { target: 'esnext' },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['mupdf'] },
});
