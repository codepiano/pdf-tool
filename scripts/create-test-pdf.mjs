import { PDFDocument, StandardFonts } from 'pdf-lib';
import { mkdir, writeFile } from 'node:fs/promises';

await mkdir('tmp/pdfs', { recursive: true });
const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.Helvetica);
for (let number = 1; number <= 4; number += 1) {
  const page = pdf.addPage([400, 260]);
  page.drawText(`Test page ${number}`, { x: 48, y: 126, size: 28, font });
}
await writeFile('tmp/pdfs/four-pages.pdf', await pdf.save());

const doublePage = await PDFDocument.create();
const spread = doublePage.addPage([800, 400]);
spread.drawRectangle({ x: 0, y: 0, width: 400, height: 400, color: { type: 'RGB', red: 0.93, green: 0.84, blue: 0.72 } });
spread.drawRectangle({ x: 400, y: 0, width: 400, height: 400, color: { type: 'RGB', red: 0.74, green: 0.84, blue: 0.92 } });
spread.drawLine({ start: { x: 400, y: 0 }, end: { x: 400, y: 400 }, thickness: 2 });
spread.drawText('LEFT PAGE', { x: 110, y: 190, size: 30, font });
spread.drawText('RIGHT PAGE', { x: 490, y: 190, size: 30, font });
await writeFile('tmp/pdfs/double-page-spread.pdf', await doublePage.save());
