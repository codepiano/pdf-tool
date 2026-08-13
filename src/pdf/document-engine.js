import { PDFDocument } from 'pdf-lib';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { createQpdfRunner } from 'qpdf-run';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

async function decryptWithQpdf(bytes) {
  const runner = await createQpdfRunner({
    workerUrl: new URL('qpdf-run/worker', import.meta.url).href,
    qpdfJsUrl: new URL('qpdf-run/qpdf.js', import.meta.url).href,
    wasmUrl: new URL('qpdf-run/qpdf.wasm', import.meta.url).href,
    timeoutMs: 120000,
  });
  try {
    return await runner.runOne({
      input: new Uint8Array(bytes),
      inputName: 'source.pdf',
      outputName: 'unrestricted.pdf',
      args: ['--decrypt', '--', 'source.pdf', 'unrestricted.pdf'],
    });
  } finally {
    await runner.destroy();
  }
}

export async function readPdfFile(file) {
  const originalBytes = await file.arrayBuffer();
  let bytes = originalBytes;
  let pdf;
  let wasRestricted = false;
  try {
    pdf = await PDFDocument.load(bytes);
  } catch {
    bytes = await decryptWithQpdf(originalBytes);
    pdf = await PDFDocument.load(bytes);
    wasRestricted = true;
  }
  const pageCount = pdf.getPageCount();
  if (!pageCount) throw new Error('PDF contains no pages');
  return { bytes, pageCount, wasRestricted };
}

export function openPdfRenderer(bytes) {
  // PDF.js transfers this buffer to its worker, so keep the source bytes isolated.
  const loadingTask = getDocument({ data: new Uint8Array(bytes).slice() });
  return {
    documentPromise: loadingTask.promise,
    destroy: () => loadingTask.destroy(),
  };
}

export async function renderPageThumbnail(pdfDocument, pageNumber, maxWidth = 132) {
  const page = await pdfDocument.getPage(pageNumber);
  const initialViewport = page.getViewport({ scale: 1 });
  const scale = Math.min(1.5, maxWidth / initialViewport.width);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(viewport.width));
  canvas.height = Math.max(1, Math.round(viewport.height));
  const context = canvas.getContext('2d', { alpha: false });
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: context, viewport }).promise;
  page.cleanup();
  return canvas;
}

export async function createPageSubset(bytes, pageIndices) {
  const source = await PDFDocument.load(bytes);
  const output = await PDFDocument.create();
  const copiedPages = await output.copyPages(source, pageIndices);
  copiedPages.forEach((page) => output.addPage(page));
  return output.save();
}
