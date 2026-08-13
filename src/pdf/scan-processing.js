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

export async function splitDoublePages(bytes, angle, onProgress = () => {}) {
  const renderer = openPdfRenderer(bytes);
  const source = await renderer.documentPromise;
  const output = await PDFDocument.create();
  try {
    for (let index = 1; index <= source.numPages; index += 1) {
      onProgress(index, source.numPages);
      const sourcePage = await source.getPage(index);
      const viewport = sourcePage.getViewport({ scale: 2 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const context = canvas.getContext('2d', { alpha: false });
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      await sourcePage.render({ canvasContext: context, viewport }).promise;
      const adjustedCanvas = rotateCanvas(canvas, angle);
      const originalViewport = sourcePage.getViewport({ scale: 1 });
      const scale = adjustedCanvas.height / canvas.height;
      const halfWidth = Math.floor(adjustedCanvas.width / 2);
      for (const sourceX of [0, adjustedCanvas.width - halfWidth]) {
        const halfCanvas = document.createElement('canvas');
        halfCanvas.width = halfWidth;
        halfCanvas.height = adjustedCanvas.height;
        const halfContext = halfCanvas.getContext('2d', { alpha: false });
        halfContext.fillStyle = '#ffffff';
        halfContext.fillRect(0, 0, halfCanvas.width, halfCanvas.height);
        halfContext.drawImage(adjustedCanvas, sourceX, 0, halfWidth, adjustedCanvas.height, 0, 0, halfWidth, adjustedCanvas.height);
        const image = await output.embedJpg(halfCanvas.toDataURL('image/jpeg', 0.94));
        const page = output.addPage([(originalViewport.width / 2) * scale, originalViewport.height * scale]);
        page.drawImage(image, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
      }
      sourcePage.cleanup();
    }
    return output.save();
  } finally {
    await renderer.destroy();
  }
}
