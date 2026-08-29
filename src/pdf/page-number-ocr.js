import { createWorker } from 'tesseract.js';
import { openPdfRenderer } from './document-engine.js';

const PAGE_NUMBER_RE = /(?:^|\s)([0-9０-９]{1,5})(?:\s|$)/g;

function normalizeDigits(value) {
  return String(value || '')
    .replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xff10 + 48))
    .replace(/[Oo]/g, '0')
    .replace(/[Il|]/g, '1')
    .replace(/[^0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parsePageNumber(text) {
  const normalized = normalizeDigits(text);
  const matches = [...normalized.matchAll(PAGE_NUMBER_RE)].map((match) => Number(match[1]));
  const valid = matches.filter((page) => page > 0 && page < 100000);
  return valid.length ? valid[valid.length - 1] : null;
}

export function parseTocLines(text) {
  return String(text || '').split(/\r?\n/).map((raw, index) => {
    const cleaned = raw.replace(/\s+/g, ' ').trim();
    const page = parsePageNumber(cleaned);
    if (!cleaned || page === null) return null;
    const title = cleaned
      .replace(/(?:[.·…_\- ]{2,})?[0-9０-９]{1,5}\s*$/, '')
      .trim();
    return title ? { title, printedPage: page, sourceLine: index + 1 } : null;
  }).filter(Boolean);
}

function preprocessRegion(source, region) {
  const width = source.width;
  const height = source.height;
  const regionHeight = Math.round(height * 0.16);
  const y = region === 'header' ? 0 : height - regionHeight;
  const output = document.createElement('canvas');
  output.width = width * 2;
  output.height = regionHeight * 2;
  const context = output.getContext('2d', { alpha: false });
  context.fillStyle = '#fff';
  context.fillRect(0, 0, output.width, output.height);
  context.filter = 'grayscale(1) contrast(1.45)';
  context.drawImage(source, 0, y, width, regionHeight, 0, 0, output.width, output.height);
  context.filter = 'none';
  return output;
}

async function renderPage(pdf, pageNumber) {
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 2 });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const context = canvas.getContext('2d', { alpha: false });
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: context, viewport }).promise;
  page.cleanup();
  return canvas;
}

async function createOcrWorker(language, onProgress = () => {}) {
  const worker = await createWorker(language, 1, {
    logger: (message) => onProgress(message),
  });
  await worker.setParameters({
    tessedit_pageseg_mode: language === 'eng' ? '7' : '6',
    ...(language === 'eng' ? { tessedit_char_whitelist: '0123456789OoIl|' } : {}),
  });
  return worker;
}

export function createPageNumberOcrWorker(onProgress = () => {}) {
  return createOcrWorker('eng', onProgress);
}

export function createTocOcrWorker(onProgress = () => {}) {
  return createOcrWorker('chi_sim+eng', onProgress);
}

export async function recognizePageNumber(worker, bytes, pageNumber, region = 'footer') {
  const renderer = openPdfRenderer(bytes);
  try {
    const pdf = await renderer.documentPromise;
    const pageImage = await renderPage(pdf, pageNumber);
    const crop = preprocessRegion(pageImage, region);
    const result = await worker.recognize(crop);
    return { pageNumber, printedPage: parsePageNumber(result.data.text), text: result.data.text.trim() };
  } finally {
    await renderer.destroy();
  }
}

export async function recognizePageText(worker, bytes, pageNumber) {
  const renderer = openPdfRenderer(bytes);
  try {
    const pdf = await renderer.documentPromise;
    const pageImage = await renderPage(pdf, pageNumber);
    const result = await worker.recognize(pageImage);
    return { pageNumber, text: result.data.text.trim() };
  } finally {
    await renderer.destroy();
  }
}

export async function recognizePageNumbers(worker, bytes, pageNumbers, regions = ['footer', 'header'], onProgress = () => {}) {
  const renderer = openPdfRenderer(bytes);
  try {
    const pdf = await renderer.documentPromise;
    const results = [];
    for (let index = 0; index < pageNumbers.length; index += 1) {
      const pageNumber = pageNumbers[index];
      const pageImage = await renderPage(pdf, pageNumber);
      let result = { pageNumber, printedPage: null, text: '' };
      for (const region of regions) {
        const crop = preprocessRegion(pageImage, region);
        const recognized = await worker.recognize(crop);
        result = { pageNumber, printedPage: parsePageNumber(recognized.data.text), text: recognized.data.text.trim() };
        if (result.printedPage !== null) break;
      }
      results.push(result);
      onProgress(index + 1, pageNumbers.length, result);
    }
    return results;
  } finally {
    await renderer.destroy();
  }
}

export function mapPrintedPagesToPdf(results) {
  const mapping = new Map();
  results.filter((item) => item.printedPage !== null).forEach((item) => {
    if (!mapping.has(item.printedPage)) mapping.set(item.printedPage, item.pageNumber);
  });
  return mapping;
}
