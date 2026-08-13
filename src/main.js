import { createPageSubset, openPdfRenderer, readPdfFile, renderPageThumbnail } from './pdf/document-engine.js';
import { formatPageRange, parsePageRange } from './pdf/page-range.js';
import { splitDoublePages } from './pdf/scan-processing.js';
import './style.css';

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
const pageBrowser = $('#page-browser');
const thumbnailGrid = $('#thumbnail-grid');
const selectedCount = $('#selected-count');
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
let selectedPages = new Set();
let selectionAnchor = null;
let rendererHandle = null;
let thumbnailObserver = null;
let documentGeneration = 0;

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
  const { pages, error } = parsePageRange(pageRange.value, pageCount);
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

function updateThumbnailSelection() {
  thumbnailGrid.querySelectorAll('.page-thumbnail').forEach((thumbnail) => {
    const selected = selectedPages.has(Number(thumbnail.dataset.page));
    thumbnail.classList.toggle('selected', selected);
    thumbnail.setAttribute('aria-pressed', String(selected));
  });
  selectedCount.textContent = `已选 ${selectedPages.size} 页`;
}

function syncSelectionFromInput() {
  const { pages, error } = parsePageRange(pageRange.value, pageCount);
  if (!error) selectedPages = new Set(pages);
  updateThumbnailSelection();
  updateSelection();
}

function syncInputFromSelection() {
  pageRange.value = formatPageRange(selectedPages);
  updateThumbnailSelection();
  updateSelection();
}

function toggleThumbnailPage(page, extendRange) {
  if (extendRange && selectionAnchor !== null) {
    const start = Math.min(selectionAnchor, page);
    const end = Math.max(selectionAnchor, page);
    for (let current = start; current <= end; current += 1) selectedPages.add(current);
  } else if (selectedPages.has(page)) {
    selectedPages.delete(page);
  } else {
    selectedPages.add(page);
  }
  selectionAnchor = page;
  syncInputFromSelection();
}

async function renderObservedThumbnail(thumbnail, pdfDocument, generation) {
  if (thumbnail.dataset.rendered === 'true') return;
  thumbnail.dataset.rendered = 'true';
  try {
    const canvas = await renderPageThumbnail(pdfDocument, Number(thumbnail.dataset.page));
    if (generation !== documentGeneration || !thumbnail.isConnected) return;
    const paper = thumbnail.querySelector('.thumbnail-paper');
    paper.replaceChildren(canvas);
  } catch (error) {
    thumbnail.dataset.rendered = 'false';
    console.warn('无法生成页面缩略图', error);
  }
}

async function buildThumbnailBrowser(bytes) {
  documentGeneration += 1;
  const generation = documentGeneration;
  thumbnailObserver?.disconnect();
  if (rendererHandle) await rendererHandle.destroy();
  rendererHandle = openPdfRenderer(bytes);
  const pdfDocument = await rendererHandle.documentPromise;
  if (generation !== documentGeneration) return;
  const fragment = document.createDocumentFragment();
  for (let page = 1; page <= pageCount; page += 1) {
    const thumbnail = document.createElement('button');
    thumbnail.type = 'button';
    thumbnail.className = 'page-thumbnail';
    thumbnail.dataset.page = String(page);
    thumbnail.setAttribute('aria-label', `第 ${page} 页`);
    thumbnail.setAttribute('aria-pressed', 'false');
    thumbnail.innerHTML = `<span class="thumbnail-paper"><span class="thumbnail-placeholder"></span></span><span class="thumbnail-number"><span>PAGE ${page}</span><span class="selection-mark">✓</span></span>`;
    thumbnail.addEventListener('click', (event) => toggleThumbnailPage(page, event.shiftKey));
    fragment.appendChild(thumbnail);
  }
  thumbnailGrid.replaceChildren(fragment);
  thumbnailObserver = new IntersectionObserver((entries) => {
    entries.filter((entry) => entry.isIntersecting).forEach((entry) => {
      thumbnailObserver.unobserve(entry.target);
      renderObservedThumbnail(entry.target, pdfDocument, generation);
    });
  }, { root: thumbnailGrid, rootMargin: '180px' });
  thumbnailGrid.querySelectorAll('.page-thumbnail').forEach((thumbnail) => thumbnailObserver.observe(thumbnail));
  updateThumbnailSelection();
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
  pageBrowser.classList.toggle('hidden', !usesPages);
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
    const loadedPdf = await readPdfFile(file);
    sourceBytes = loadedPdf.bytes;
    pageCount = loadedPdf.pageCount;
    wasRestricted = loadedPdf.wasRestricted;
    sourceFile = file;
    fileName.textContent = file.name;
    fileMeta.textContent = `${pageCount} 页 · ${formatSize(file.size)}${wasRestricted ? ' · 已解除使用限制' : ''}`;
    totalPages.textContent = pageCount;
    uploadCard.classList.add('hidden');
    documentCard.classList.remove('hidden');
    pageRange.value = '';
    selectedPages = new Set();
    selectionAnchor = null;
    await buildThumbnailBrowser(sourceBytes);
    setOperation(wasRestricted ? 'unlock' : 'extract');
    if (!wasRestricted) pageRange.focus();
  } catch (error) {
    console.error(error);
    showToast('无法读取该 PDF。它可能需要打开密码，或文件已损坏。');
  }
}

async function generatePdf() {
  const { pages, error } = parsePageRange(pageRange.value, pageCount);
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
      bytes = await splitDoublePages(sourceBytes, Number(deskewAngle.value), (current, total) => {
        selectionSummary.textContent = `正在切割第 ${current} / ${total} 张双页…`;
      });
    } else {
      bytes = await createPageSubset(sourceBytes, indices);
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

$('#browse-button').addEventListener('click', () => fileInput.click());
$('#replace-button').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (event) => loadFile(event.target.files[0]));
uploadCard.addEventListener('dragover', (event) => { event.preventDefault(); uploadCard.classList.add('dragging'); });
uploadCard.addEventListener('dragleave', () => uploadCard.classList.remove('dragging'));
uploadCard.addEventListener('drop', (event) => { event.preventDefault(); uploadCard.classList.remove('dragging'); loadFile(event.dataTransfer.files[0]); });
document.addEventListener('dragover', (event) => event.preventDefault());
document.addEventListener('drop', (event) => { if (event.target !== uploadCard && !uploadCard.contains(event.target)) loadFile(event.dataTransfer.files[0]); });
document.querySelectorAll('.operation').forEach((button) => button.addEventListener('click', () => setOperation(button.dataset.operation)));
pageRange.addEventListener('input', syncSelectionFromInput);
deskewAngle.addEventListener('input', () => { deskewValue.textContent = `${Number(deskewAngle.value).toFixed(1).replace('.0', '')}°`; updateSelection(); });
$('#deskew-left').addEventListener('click', () => changeDeskewAngle(-0.1));
$('#deskew-right').addEventListener('click', () => changeDeskewAngle(0.1));
selectAllButton.addEventListener('click', () => { selectedPages = new Set(Array.from({ length: pageCount }, (_, index) => index + 1)); syncInputFromSelection(); pageRange.focus(); });
$('#clear-selection-button').addEventListener('click', () => { selectedPages.clear(); selectionAnchor = null; syncInputFromSelection(); });
processButton.addEventListener('click', generatePdf);
