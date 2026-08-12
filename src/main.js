import { PDFDocument } from 'pdf-lib';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { createQpdfRunner } from 'qpdf-run';
import './style.css';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const $ = (selector) => document.querySelector(selector);
const fileInput = $('#file-input');
const uploadCard = $('#upload-card');
const documentCard = $('#document-card');
const fileName = $('#file-name');
const fileMeta = $('#file-meta');
const totalPages = $('#total-pages');
const pageRange = $('#page-range');
const rangeLabel = $('#range-label');
const rangeError = $('#range-error');
const rangeEditor = $('#range-editor');
const splitNotice = $('#split-notice');
const deskewAngle = $('#deskew-angle');
const deskewValue = $('#deskew-value');
const selectionSummary = $('#selection-summary');
const processButton = $('#process-button');
const selectAllButton = $('#select-all-button');
const toast = $('#toast');

let sourceFile = null;
let sourceBytes = null;
let pageCount = 0;
let operation = 'extract';
let wasRestricted = false;

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

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function parsePages(value) {
  const raw = value.trim();
  if (!raw) return { pages: [], error: '' };
  if (!/^[\d\s,\-–]+$/.test(raw)) return { pages: [], error: '请只输入页码、英文逗号和连字符。' };
  const pages = [];
  for (const part of raw.split(',')) {
    const item = part.trim().replace('–', '-');
    if (!item) return { pages: [], error: '页码之间请不要留下空项。' };
    const match = item.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!match) return { pages: [], error: `“${item}” 不是有效的页码格式。` };
    const start = Number(match[1]);
    const end = Number(match[2] || match[1]);
    if (start < 1 || end < 1 || start > end) return { pages: [], error: `“${item}” 不是有效的页码范围。` };
    if (end > pageCount) return { pages: [], error: `页码不能超过第 ${pageCount} 页。` };
    for (let page = start; page <= end; page += 1) pages.push(page);
  }
  return { pages: [...new Set(pages)].sort((a, b) => a - b), error: '' };
}

function updateSelection() {
  if (operation === 'split') {
    rangeError.classList.add('hidden');
    processButton.disabled = false;
    const angle = Number(deskewAngle.value);
    selectionSummary.textContent = `将把 ${pageCount} 个阅读器页面切为 ${pageCount * 2} 页（左页在前）${angle ? `，并旋转 ${Math.abs(angle)}° 校正倾斜` : ''}`;
    return;
  }
  if (operation === 'unlock') {
    rangeError.classList.add('hidden');
    processButton.disabled = false;
    selectionSummary.textContent = `将生成完整的 ${pageCount} 页 PDF，不保留使用限制`;
    return;
  }
  const { pages, error } = parsePages(pageRange.value);
  rangeError.textContent = error;
  rangeError.classList.toggle('hidden', !error);
  processButton.disabled = Boolean(error) || pages.length === 0;
  if (error || pages.length === 0) {
    selectionSummary.textContent = error ? '请修正页码后继续' : '输入页码以继续';
    return;
  }
  const unaffected = pageCount - pages.length;
  selectionSummary.textContent = operation === 'extract'
    ? `将生成包含 ${pages.length} 页的新 PDF`
    : unaffected ? `将删除 ${pages.length} 页，保留 ${unaffected} 页` : '不能删除全部页面';
  if (operation === 'delete' && !unaffected) processButton.disabled = true;
}

function setOperation(nextOperation) {
  operation = nextOperation;
  document.querySelectorAll('.operation').forEach((button) => {
    const active = button.dataset.operation === operation;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  const usesPages = operation === 'extract' || operation === 'delete';
  rangeEditor.classList.toggle('hidden', !usesPages);
  splitNotice.classList.toggle('hidden', operation !== 'split');
  rangeLabel.textContent = operation === 'extract' ? '要提取哪些页？' : '要删除哪些页？';
  processButton.innerHTML = operation === 'extract'
    ? '生成新 PDF <span aria-hidden="true">→</span>'
    : operation === 'delete'
      ? '删除并生成新 PDF <span aria-hidden="true">→</span>'
      : operation === 'unlock'
        ? '生成无使用限制副本 <span aria-hidden="true">→</span>'
        : '切开并生成新 PDF <span aria-hidden="true">→</span>';
  updateSelection();
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.remove('hidden');
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.add('hidden'), 3600);
}

function changeDeskewAngle(delta) {
  const next = Math.max(-3, Math.min(3, Number((Number(deskewAngle.value) + delta).toFixed(1))));
  deskewAngle.value = String(next);
  deskewAngle.dispatchEvent(new Event('input', { bubbles: true }));
}

async function loadFile(file) {
  if (!file) return;
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    showToast('请选择 PDF 文件。');
    return;
  }
  try {
    wasRestricted = false;
    const originalBytes = await file.arrayBuffer();
    let readableBytes = originalBytes;
    let pdf;
    try {
      pdf = await PDFDocument.load(readableBytes);
    } catch {
      readableBytes = await decryptWithQpdf(originalBytes);
      pdf = await PDFDocument.load(readableBytes);
      wasRestricted = true;
    }
    sourceBytes = readableBytes;
    pageCount = pdf.getPageCount();
    if (!pageCount) throw new Error('empty');
    sourceFile = file;
    fileName.textContent = file.name;
    fileMeta.textContent = `${pageCount} 页 · ${formatSize(file.size)}${wasRestricted ? ' · 已解除使用限制' : ''}`;
    totalPages.textContent = pageCount;
    uploadCard.classList.add('hidden');
    documentCard.classList.remove('hidden');
    pageRange.value = '';
    setOperation(wasRestricted ? 'unlock' : 'extract');
    pageRange.focus();
  } catch (error) {
    console.error(error);
    showToast('无法读取该 PDF。它可能需要打开密码，或文件已损坏。');
  }
}

async function generatePdf() {
  const { pages, error } = parsePages(pageRange.value);
  const requiresPages = operation === 'extract' || operation === 'delete';
  if ((requiresPages && (error || !pages.length)) || !sourceBytes) return;
  const selected = new Set(pages);
  const indices = operation === 'extract'
    ? pages.map((page) => page - 1)
    : operation === 'delete'
      ? Array.from({ length: pageCount }, (_, index) => index).filter((index) => !selected.has(index + 1))
      : Array.from({ length: pageCount }, (_, index) => index);
  if (!indices.length) return;
  processButton.disabled = true;
  processButton.textContent = '正在生成…';
  try {
    let bytes;
    if (operation === 'unlock') {
      bytes = sourceBytes;
    } else if (operation === 'split') {
      bytes = await splitDoublePages(sourceBytes, Number(deskewAngle.value));
    } else {
      const source = await PDFDocument.load(sourceBytes);
      const output = await PDFDocument.create();
      const copiedPages = await output.copyPages(source, indices);
      copiedPages.forEach((page) => output.addPage(page));
      bytes = await output.save();
    }
    const stem = sourceFile.name.replace(/\.pdf$/i, '');
    const suffix = operation === 'extract' ? '提取页' : operation === 'delete' ? '已删除页' : operation === 'unlock' ? '无使用限制' : '双页已切开';
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const link = Object.assign(document.createElement('a'), { href: url, download: `${stem}-${suffix}.pdf` });
    link.click();
    URL.revokeObjectURL(url);
    showToast(operation === 'unlock' ? '无使用限制的 PDF 已开始下载。' : operation === 'split' ? '切开的 PDF 已开始下载。' : '新 PDF 已开始下载。');
  } catch (error) {
    console.error(error);
    showToast(operation === 'unlock' ? '无法生成副本。若文件需要打开密码，请先在阅读器中解锁后再试。' : operation === 'split' ? '切割失败，请重新选择文件后再试。' : '生成失败，请重新选择文件后再试。');
  } finally {
    processButton.disabled = false;
    setOperation(operation);
  }
}

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

async function splitDoublePages(bytes, angle) {
  const loadingTask = getDocument({ data: new Uint8Array(bytes) });
  const source = await loadingTask.promise;
  const output = await PDFDocument.create();
  try {
    for (let index = 1; index <= source.numPages; index += 1) {
      selectionSummary.textContent = `正在切割第 ${index} / ${source.numPages} 张双页…`;
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
    }
    return output.save();
  } finally {
    await loadingTask.destroy();
  }
}

$('#browse-button').addEventListener('click', () => fileInput.click());
$('#replace-button').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (event) => loadFile(event.target.files[0]));
uploadCard.addEventListener('dragover', (event) => { event.preventDefault(); uploadCard.classList.add('dragging'); });
uploadCard.addEventListener('dragleave', () => uploadCard.classList.remove('dragging'));
uploadCard.addEventListener('drop', (event) => { event.preventDefault(); uploadCard.classList.remove('dragging'); loadFile(event.dataTransfer.files[0]); });
document.addEventListener('dragover', (event) => event.preventDefault());
document.addEventListener('drop', (event) => { if (event.target !== uploadCard && !uploadCard.contains(event.target)) loadFile(event.dataTransfer.files[0]); });
document.querySelectorAll('.operation').forEach((button) => button.addEventListener('click', () => setOperation(button.dataset.operation)));
pageRange.addEventListener('input', updateSelection);
deskewAngle.addEventListener('input', () => { deskewValue.textContent = `${Number(deskewAngle.value).toFixed(1).replace('.0', '')}°`; updateSelection(); });
$('#deskew-left').addEventListener('click', () => changeDeskewAngle(-0.1));
$('#deskew-right').addEventListener('click', () => changeDeskewAngle(0.1));
selectAllButton.addEventListener('click', () => { pageRange.value = `1-${pageCount}`; updateSelection(); pageRange.focus(); });
processButton.addEventListener('click', generatePdf);
