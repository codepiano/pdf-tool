import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { inspectPage, pageCandidates, buildPlan, applyPageRemovals, protectedCharacters, samplePages } from '../src/pdf/header-footer.js';

async function fixture(count = 8) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= count; n++) {
    const p = doc.addPage([600, 800]);
    p.drawRectangle({ x: 0, y: 735, width: 600, height: 65, color: rgb(.9, .93, .96) });
    p.drawText(`${n % 2 ? 'Example Book' : 'Chapter Name'}    ${n}`, { x: 40, y: 765, size: 12, font });
    p.drawText('Example Book in the body', { x: 40, y: 420, size: 16, font });
    p.drawText(`Publisher    Page ${n} of ${count}`, { x: 40, y: 25, size: 12, font });
  }
  return doc.save();
}
function analyze(doc, targets = [], options) {
  const pages = [], candidates = [];
  for (let n = 1; n <= doc.countPages(); n++) {
    const page = doc.loadPage(n - 1);
    try {
      const info = inspectPage(page, n, options);
      candidates.push(...pageCandidates(info, targets));
      pages.push({ number: n, bounds: info.bounds, protected: info.protected, warning: info.warning });
    } finally { page.destroy(); }
  }
  return buildPlan(pages, candidates, targets);
}
function text(page) { const t = page.toStructuredText(); try { return t.asText(); } finally { t.destroy(); } }
function glyphs(page) {
  const t = page.toStructuredText(); const result = [];
  try { t.walk({ onChar(c, origin, font, size, quad) { result.push({ c, origin, quad }); } }); return result; }
  finally { t.destroy(); }
}

test('explicit text removes real glyphs, preserving same-line numbering, body geometry, color and page count after save', async () => {
  const doc = mupdf.Document.openDocument(await fixture(), 'application/pdf');
  const plan = analyze(doc, ['ExampleBook', 'ChapterName', 'Publisher']);
  assert.equal(plan.candidates.length, 16);
  const before = [];
  for (let n = 1; n <= doc.countPages(); n++) {
    const p = doc.loadPage(n - 1);
    before.push(glyphs(p).filter((g) => g.origin[1] > 300 && g.origin[1] < 500));
    applyPageRemovals(p, plan.candidates.filter((c) => c.page === n), mupdf);
    p.destroy();
  }
  const buffer = doc.saveToBuffer('garbage=4,compress');
  const saved = mupdf.Document.openDocument(buffer.asUint8Array().slice(), 'application/pdf');
  assert.equal(saved.countPages(), 8);
  for (let n = 1; n <= 8; n++) {
    const p = saved.loadPage(n - 1);
    const value = text(p);
    const pixmap = p.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false);
    assert.deepEqual([...pixmap.getPixels().slice((10 * 600 + 10) * 3, (10 * 600 + 10) * 3 + 3)], [229, 237, 244]);
    pixmap.destroy();
    assert.equal(value.split('Example Book').length - 1, 1);
    assert.ok(!value.includes('Publisher'));
    assert.ok(!value.includes('Chapter Name'));
    assert.ok(value.includes(`Page ${n} of 8`));
    assert.match(value, new RegExp(`\\s${n}\\s`));
    assert.deepEqual(p.getBounds(), [0, 0, 600, 800]);
    assert.deepEqual(glyphs(p).filter((g) => g.origin[1] > 300 && g.origin[1] < 500), before[n - 1]);
    p.destroy();
  }
  saved.destroy(); buffer.destroy(); doc.destroy();
});

test('automatic inference recognizes alternating styles and ignores a single occurrence', async () => {
  const doc = mupdf.Document.openDocument(await fixture(), 'application/pdf');
  const plan = analyze(doc);
  assert.equal(plan.groups.length, 3);
  assert.equal(plan.candidates.length, 16);
  doc.destroy();
  const short = mupdf.Document.openDocument(await fixture(1), 'application/pdf');
  assert.equal(analyze(short).candidates.length, 0);
  short.destroy();
});

test('explicit unmatched input never falls back; numeric targets and whole page labels are protected', async () => {
  const doc = mupdf.Document.openDocument(await fixture(), 'application/pdf');
  assert.deepEqual(analyze(doc, ['Missing']).unmatched, ['Missing']);
  assert.equal(analyze(doc, ['Missing']).candidates.length, 0);
  assert.equal(analyze(doc, ['Page1of8', '1']).candidates.length, 0);
  assert.equal(analyze(doc, ['Publisher'], { region: 'header' }).candidates.length, 0);
  assert.equal(analyze(doc, ['Publisher'], { region: 'footer' }).candidates.length, 8);
  doc.destroy();
});

test('Roman, fullwidth, Chinese and chapter-prefixed page numbers are preserved', () => {
  for (const s of ['— iv —', '第１２页', '第十二页', 'Page 9 of 120', 'A-23', 'Ⅷ', '第十二页 / 共一百页', 'iv / xx', '12 of 100']) {
    const chars = [...s].map((text) => ({ text }));
    assert.equal(protectedCharacters(chars).size, chars.length, s);
  }
});

test('pre-existing redactions and image-only pages are skipped', async () => {
  const doc = mupdf.Document.openDocument(await fixture(1), 'application/pdf');
  const p = doc.loadPage(0);
  p.createAnnotation('Redact').setRect([40, 350, 200, 400]);
  assert.match(inspectPage(p, 1).warning, /涂黑/);
  assert.throws(() => applyPageRemovals(p, [{ cuts: [[40, 20, 80, 25]] }], mupdf), /涂黑/);
  p.destroy(); doc.destroy();
  const blank = await PDFDocument.create(); blank.addPage();
  const empty = mupdf.Document.openDocument(await blank.save(), 'application/pdf');
  const page = empty.loadPage(0);
  assert.match(inspectPage(page, 1).warning, /文字层/);
  page.destroy(); empty.destroy();
});

test('rotated text is retained conservatively; cropped pages stay within the visible margin', async () => {
  const file = await PDFDocument.load(await fixture(1));
  file.getPage(0).setRotation(degrees(90));
  const doc = mupdf.Document.openDocument(await file.save(), 'application/pdf');
  assert.equal(analyze(doc, ['ExampleBook', 'Publisher']).candidates.length, 0);
  doc.destroy();
  file.getPage(0).setRotation(degrees(0));
  file.getPage(0).setCropBox(20, 100, 560, 600);
  const cropped = mupdf.Document.openDocument(await file.save(), 'application/pdf');
  assert.equal(analyze(cropped, ['ExampleBook', 'Publisher']).candidates.length, 0);
  cropped.destroy();
});

test('300-page analysis keeps preview samples bounded while finding all matches', async () => {
  const doc = mupdf.Document.openDocument(await fixture(300), 'application/pdf');
  const plan = analyze(doc);
  assert.equal(plan.candidates.length, 600);
  assert.ok(plan.samples.length <= 12);
  assert.ok(plan.samples.includes(300));
  assert.equal(samplePages(1).length, 1);
  doc.destroy();
});

test('Chinese text and a same-line Chinese printed page number can be separated', () => {
  const pdf = new mupdf.PDFDocument();
  const font = new mupdf.Font('zh-Hans');
  const ref = pdf.addCJKFont(font, 'Adobe-GB1', 0, true);
  const hex = (s) => [...s].map((c) => c.charCodeAt(0).toString(16).padStart(4, '0')).join('');
  const obj = pdf.addPage([0, 0, 600, 800], 0, { Font: { F1: ref } }, `BT /F1 12 Tf 1 0 0 1 40 765 Tm <${hex('测试书名　　第十二页')}> Tj ET BT /F1 14 Tf 1 0 0 1 40 400 Tm <${hex('测试书名与正文不变')}> Tj ET`);
  pdf.insertPage(-1, obj);
  const page = pdf.loadPage(0);
  const info = inspectPage(page, 1);
  const matches = pageCandidates(info, ['测试书名']);
  assert.equal(matches.length, 1);
  applyPageRemovals(page, matches, mupdf);
  assert.ok(text(page).includes('第十二页'));
  assert.equal(text(page).split('测试书名').length - 1, 1);
  page.destroy(); obj.destroy(); ref.destroy(); font.destroy(); pdf.destroy();
});

test('a matching title overlapping a separately drawn page number is skipped', async () => {
  const file = await PDFDocument.create();
  const p = file.addPage([600, 800]);
  p.drawText('Book', { x: 40, y: 765, size: 12 });
  p.drawText('7', { x: 41, y: 765, size: 12 });
  const pdf = mupdf.Document.openDocument(await file.save(), 'application/pdf');
  const plan = analyze(pdf, ['Book']);
  assert.equal(plan.candidates.length, 0);
  assert.match(plan.pages[0].warning, /无法可靠分离/);
  pdf.destroy();
});

test('a full-page scan with a text overlay is skipped', async () => {
  const source = mupdf.Document.openDocument(await fixture(1), 'application/pdf');
  const page = source.loadPage(0);
  const pixmap = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false);
  const pdf = await PDFDocument.create();
  const img = await pdf.embedPng(pixmap.asPNG());
  const p = pdf.addPage([600, 800]);
  p.drawImage(img, { x: 0, y: 0, width: 600, height: 800 });
  p.drawText('Example Book', { x: 40, y: 765, size: 12 });
  const doc = mupdf.Document.openDocument(await pdf.save(), 'application/pdf');
  const plan = analyze(doc, ['ExampleBook']);
  assert.equal(plan.candidates.length, 0);
  assert.match(plan.pages[0].warning, /扫描图/);
  doc.destroy(); pixmap.destroy(); page.destroy(); source.destroy();
});

test('MIT download attribution matches across lines, removing URL and date numbers but preserving page numbers', async () => {
  const notice = 'Downloaded from direct. mit. edu/ books/ oa-monograph-pdf/ 2259328/ book\\_9780262342964. pdf by guest on 08 September 2026';
  const file = await PDFDocument.create();
  for (let n = 1; n <= 6; n++) {
    const p = file.addPage([600, 800]);
    p.drawText('Body stays here', { x: 40, y: 400, size: 14 });
    if (n <= 3) {
      p.drawText(notice.replace('\\_', '_'), { x: 40, y: 30, size: 6 });
    } else {
    p.drawText('Downloaded from direct.mit.edu/books/oa-monograph-pdf/2259328/', { x: 40, y: 42, size: 8 });
    p.drawText('book_9780262342964.pdf by guest on 08 September 2026', { x: 40, y: 30, size: 8 });
    }
    p.drawText(`Page ${n} of 6`, { x: 480, y: 30, size: 8 });
  }
  const pdf = mupdf.Document.openDocument(await file.save(), 'application/pdf');
  const plan = analyze(pdf, [notice]);
  assert.equal(plan.candidates.length, 6);
  assert.deepEqual(plan.unmatched, []);
  // Automatic inference also removes the resource identifiers and date.
  const automatic = analyze(pdf);
  assert.equal(automatic.candidates.length, 9);
  for (let n = 1; n <= 6; n++) {
    const page = pdf.loadPage(n - 1);
    applyPageRemovals(page, plan.candidates.filter(c => c.page === n), mupdf);
    const value = text(page);
    assert.ok(value.includes(`Page ${n} of 6`));
    assert.ok(value.includes('Body stays here'));
    assert.ok(!/Downloaded|2259328|9780262342964|September|2026/.test(value));
    page.destroy();
  }
  pdf.destroy();
});
