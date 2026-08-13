import { degrees, PDFDocument } from 'pdf-lib';

export async function rotatePdfPages(bytes, pageNumbers, angle) {
  const pdf = await PDFDocument.load(bytes);
  const selectedPages = new Set(pageNumbers);

  pdf.getPages().forEach((page, index) => {
    if (!selectedPages.has(index + 1)) return;
    const currentAngle = page.getRotation().angle;
    page.setRotation(degrees((currentAngle + angle) % 360));
  });

  return pdf.save();
}
