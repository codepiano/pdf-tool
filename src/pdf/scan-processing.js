import { PDFDocument } from 'pdf-lib';
import { openPdfRenderer } from './document-engine.js';

function rotateCanvas(canvas, angle) {
  if (!angle) return canvas;
  const radians = (angle * Math.PI) / 180;
  const rotated = document.createElement('canvas');
  rotated.width = Math.ceil(Math.abs(canvas.width * Math.cos(radians)) + Math.abs(canvas.height * Math.sin(radians)));
  rotated.height = Math.ceil(Math.abs(canvas.width * Math.sin(radians)) + Math.abs(canvas.height * Math.cos(radians)));
  const context = rotated.getContext('2d', { alpha: false });
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, rotated.width, rotated.height);
  context.translate(rotated.width / 2, rotated.height / 2);
  context.rotate(radians);
  context.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
  return rotated;
}

function findContentBounds(canvas, paddingRatio) {
  const context = canvas.getContext('2d');
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  const step = Math.max(1, Math.ceil(Math.max(canvas.width, canvas.height) / 1800));
  let left = canvas.width;
  let top = canvas.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < canvas.height; y += step) {
    for (let x = 0; x < canvas.width; x += step) {
      const offset = (y * canvas.width + x) * 4;
      if (data[offset] < 245 || data[offset + 1] < 245 || data[offset + 2] < 245) {
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
      }
    }
  }
  if (right < left || bottom < top) return { x: 0, y: 0, width: canvas.width, height: canvas.height };
  const padding = Math.round(Math.min(canvas.width, canvas.height) * paddingRatio);
  const x = Math.max(0, left - padding);
  const y = Math.max(0, top - padding);
  return {
    x,
    y,
    width: Math.min(canvas.width, right + step + padding) - x,
    height: Math.min(canvas.height, bottom + step + padding) - y,
  };
}

async function renderPdfPage(source, index) {
  const sourcePage = await source.getPage(index);
  const viewport = sourcePage.getViewport({ scale: 2 });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const context = canvas.getContext('2d', { alpha: false });
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  await sourcePage.render({ canvasContext: context, viewport }).promise;
  return { sourcePage, canvas };
}

export async function splitDoublePages(bytes, options = {}, onProgress = () => {}) {
  const { angle = 0, selectedPages = [], splitRatio = 0.5, order = 'ltr' } = options;
  const selected = new Set(selectedPages);
  const renderer = openPdfRenderer(bytes);
  const source = await renderer.documentPromise;
  const vectorSource = await PDFDocument.load(bytes);
  const output = await PDFDocument.create();
  try {
    for (let index = 1; index <= source.numPages; index += 1) {
      onProgress(index, source.numPages);
      if (!selected.has(index)) {
        const [copiedPage] = await output.copyPages(vectorSource, [index - 1]);
        output.addPage(copiedPage);
        continue;
      }
      const { sourcePage, canvas } = await renderPdfPage(source, index);
      const adjustedCanvas = rotateCanvas(canvas, angle);
      const originalViewport = sourcePage.getViewport({ scale: 1 });
      const pointsPerPixel = originalViewport.height / canvas.height;
      const splitX = Math.max(1, Math.min(adjustedCanvas.width - 1, Math.round(adjustedCanvas.width * splitRatio)));
      const parts = [
        { sourceX: 0, width: splitX },
        { sourceX: splitX, width: adjustedCanvas.width - splitX },
      ];
      if (order === 'rtl') parts.reverse();
      for (const part of parts) {
        const halfCanvas = document.createElement('canvas');
        halfCanvas.width = part.width;
        halfCanvas.height = adjustedCanvas.height;
        const halfContext = halfCanvas.getContext('2d', { alpha: false });
        halfContext.fillStyle = '#ffffff';
        halfContext.fillRect(0, 0, halfCanvas.width, halfCanvas.height);
        halfContext.drawImage(adjustedCanvas, part.sourceX, 0, part.width, adjustedCanvas.height, 0, 0, part.width, adjustedCanvas.height);
        const image = await output.embedJpg(halfCanvas.toDataURL('image/jpeg', 0.94));
        const page = output.addPage([part.width * pointsPerPixel, adjustedCanvas.height * pointsPerPixel]);
        page.drawImage(image, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
      }
      sourcePage.cleanup();
    }
    return output.save();
  } finally {
    await renderer.destroy();
  }
}

export async function enhanceScannedPages(bytes, options = {}, onProgress = () => {}) {
  const {
    selectedPages = [], autoCrop = true, cropPadding = 0.01,
    brightness = 100, contrast = 110, grayscale = false,
  } = options;
  const selected = new Set(selectedPages);
  const renderer = openPdfRenderer(bytes);
  const source = await renderer.documentPromise;
  const vectorSource = await PDFDocument.load(bytes);
  const output = await PDFDocument.create();
  try {
    for (let index = 1; index <= source.numPages; index += 1) {
      onProgress(index, source.numPages);
      if (!selected.has(index)) {
        const [copiedPage] = await output.copyPages(vectorSource, [index - 1]);
        output.addPage(copiedPage);
        continue;
      }
      const { sourcePage, canvas } = await renderPdfPage(source, index);
      const originalViewport = sourcePage.getViewport({ scale: 1 });
      const bounds = autoCrop
        ? findContentBounds(canvas, cropPadding)
        : { x: 0, y: 0, width: canvas.width, height: canvas.height };
      const enhanced = document.createElement('canvas');
      enhanced.width = Math.max(1, bounds.width);
      enhanced.height = Math.max(1, bounds.height);
      const context = enhanced.getContext('2d', { alpha: false });
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, enhanced.width, enhanced.height);
      context.filter = `brightness(${brightness}%) contrast(${contrast}%) grayscale(${grayscale ? 100 : 0}%)`;
      context.drawImage(canvas, bounds.x, bounds.y, bounds.width, bounds.height, 0, 0, enhanced.width, enhanced.height);
      context.filter = 'none';
      const image = await output.embedJpg(enhanced.toDataURL('image/jpeg', 0.94));
      const page = output.addPage([
        originalViewport.width * (bounds.width / canvas.width),
        originalViewport.height * (bounds.height / canvas.height),
      ]);
      page.drawImage(image, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
      sourcePage.cleanup();
    }
    return output.save();
  } finally {
    await renderer.destroy();
  }
}
