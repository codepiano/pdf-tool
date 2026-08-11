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
