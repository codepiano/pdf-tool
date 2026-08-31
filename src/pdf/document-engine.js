import { PDFDocument } from 'pdf-lib';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { createQpdfRunner } from 'qpdf-run';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

function createRunner() {
  return createQpdfRunner({
    workerUrl: new URL('qpdf-run/worker', import.meta.url).href,
    qpdfJsUrl: new URL('qpdf-run/qpdf.js', import.meta.url).href,
    wasmUrl: new URL('qpdf-run/qpdf.wasm', import.meta.url).href,
    timeoutMs: 120000,
  });
}

async function decryptWithQpdf(bytes, password = '') {
  const runner = await createRunner();
  try {
    return await runner.runOne({
      input: new Uint8Array(bytes),
      inputName: 'source.pdf',
      outputName: 'unrestricted.pdf',
      args: [...(password ? [`--password=${password}`] : []), '--decrypt', '--', 'source.pdf', 'unrestricted.pdf'],
    });
  } finally {
    await runner.destroy();
  }
}

export async function readPdfFile(file, password = '') {
  const originalBytes = await file.arrayBuffer();
  let bytes = originalBytes;
  let pdf;
  let wasRestricted = false;
  try {
    pdf = await PDFDocument.load(bytes);
  } catch {
    bytes = await decryptWithQpdf(originalBytes, password);
    pdf = await PDFDocument.load(bytes);
    wasRestricted = true;
  }
  const pageCount = pdf.getPageCount();
  if (!pageCount) throw new Error('PDF contains no pages');
  return { bytes, pageCount, wasRestricted };
}

export async function protectPdf(bytes, password) {
  if (!password) throw new Error('Password is required');
  const runner = await createRunner();
  const ownerPassword = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  try {
    return await runner.runOne({
      input: new Uint8Array(bytes),
      inputName: 'source.pdf',
      outputName: 'protected.pdf',
      args: ['--encrypt', password, ownerPassword, '256', '--', 'source.pdf', 'protected.pdf'],
    });
  } finally {
    await runner.destroy();
  }
}

export function openPdfRenderer(bytes) {
  // PDF.js transfers this buffer to its worker, so keep the source bytes isolated.
  const loadingTask = getDocument({ data: new Uint8Array(bytes).slice() });
  return {
    documentPromise: loadingTask.promise,
    destroy: () => loadingTask.destroy(),
  };
}

async function resolveOutlineDestination(pdf, destination) {
  const resolved = typeof destination === 'string' ? await pdf.getDestination(destination) : destination;
  if (!Array.isArray(resolved) || !resolved[0]) return null;
  try {
    return (await pdf.getPageIndex(resolved[0])) + 1;
  } catch {
    return null;
  }
}

async function mapOutlineItems(pdf, items, depth = 0) {
  return Promise.all((items || []).map(async (item) => ({
    title: item.title || '未命名章节',
    page: await resolveOutlineDestination(pdf, item.dest),
    depth,
    children: await mapOutlineItems(pdf, item.items, depth + 1),
  })));
}

export async function readPdfOutline(bytes) {
  const renderer = openPdfRenderer(bytes);
  try {
    const pdf = await renderer.documentPromise;
    return await mapOutlineItems(pdf, await pdf.getOutline());
  } finally {
    await renderer.destroy();
  }
}

export async function createPageSubset(bytes, pageIndices) {
  const source = await PDFDocument.load(bytes);
  const output = await PDFDocument.create();
  const copiedPages = await output.copyPages(source, pageIndices);
  copiedPages.forEach((page) => output.addPage(page));
  return output.save();
}
