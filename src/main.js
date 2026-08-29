import { createPageSubset, openPdfRenderer, protectPdf, readPdfFile, renderPageThumbnail } from './pdf/document-engine.js';
import { readPdfOutline } from './pdf/document-engine.js';
import { formatPageRange, parsePageRange } from './pdf/page-range.js';
import { movePageBefore } from './pdf/page-order.js';
import { rotatePdfPages } from './pdf/page-transform.js';
import { enhanceScannedPages, splitDoublePages } from './pdf/scan-processing.js';
import { createChapterZip, parseCutPoints, rangesFromChapterStarts } from './pdf/chapter-splitting.js';
import { createPageNumberOcrWorker, createTocOcrWorker, mapPrintedPagesToPdf, parseTocLines, recognizePageNumbers, recognizePageText } from './pdf/page-number-ocr.js';
import './style.css';

const $ = (selector) => document.querySelector(selector);
const fileInput = $('#file-input');
const uploadCard = $('#upload-card');
const documentCard = $('#document-card');
const passwordPrompt = $('#password-prompt');
const passwordFileName = $('#password-file-name');
const openPassword = $('#open-password');
const fileName = $('#file-name');
const fileMeta = $('#file-meta');
const totalPages = $('#total-pages');
const pageRange = $('#page-range');
const rangeLabel = $('#range-label');
const rangeError = $('#range-error');
const rangeEditor = $('#range-editor');
const splitNotice = $('#split-notice');
const rotationPanel = $('#rotation-panel');
const passwordPanel = $('#password-panel');
const scanPanel = $('#scan-panel');
const autoCrop = $('#auto-crop');
const cropPadding = $('#crop-padding');
const scanBrightness = $('#scan-brightness');
const scanContrast = $('#scan-contrast');
const scanGrayscale = $('#scan-grayscale');
const chapterPanel = $('#chapter-panel');
const chapterModeButtons = document.querySelectorAll('[data-chapter-mode]');
const outlineList = $('#outline-list');
const outlineEmpty = $('#outline-empty');
const manualCutPointPanel = $('#manual-cut-points');
const manualCutPoints = $('#manual-cut-input');
const ocrTocPages = $('#ocr-toc-pages');
const ocrRunButton = $('#ocr-run-button');
const ocrStatus = $('#ocr-status');
const ocrList = $('#ocr-list');
const ocrChapterPanel = $('#ocr-chapter-panel');
const ocrConfirmButton = $('#ocr-confirm-button');
const newPassword = $('#new-password');
const confirmPassword = $('#confirm-password');
const pageBrowser = $('#page-browser');
const thumbnailGrid = $('#thumbnail-grid');
const selectedCount = $('#selected-count');
const pageBrowserTitle = $('#page-browser-title');
const pageBrowserHelp = $('#page-browser-help');
const selectionActions = $('#selection-actions');
const reorderActions = $('#reorder-actions');
const deskewAngle = $('#deskew-angle');
const deskewValue = $('#deskew-value');
const splitPosition = $('#split-position');
const splitPositionValue = $('#split-position-value');
const selectionSummary = $('#selection-summary');
const processButton = $('#process-button');
const selectAllButton = $('#select-all-button');
const toast = $('#toast');

let sourceFile = null;
let pendingFile = null;
let sourceBytes = null;
let pageCount = 0;
let operation = 'extract';
let wasRestricted = false;
let selectedPages = new Set();
let pageOrder = [];
let selectionAnchor = null;
let draggedPage = null;
let rotationAngle = 90;
let splitOrder = 'ltr';
let chapterMode = 'outline';
let outlineItems = [];
let ocrItems = [];
let ocrConfirmed = false;
let rendererHandle = null;
let thumbnailObserver = null;
let documentGeneration = 0;

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function updateSelection() {
  if (operation === 'reorder') {
    processButton.disabled = false;
    selectionSummary.textContent = `将按当前顺序生成 ${pageOrder.length} 页的新 PDF`;
    return;
  }
  if (operation === 'unlock') {
    rangeError.classList.add('hidden');
    processButton.disabled = false;
    selectionSummary.textContent = `将生成完整的 ${pageCount} 页 PDF，不保留使用限制`;
    return;
  }
  if (operation === 'protect') {
    rangeError.classList.add('hidden');
    const password = newPassword.value;
    const matches = password && password === confirmPassword.value;
    processButton.disabled = !matches;
    selectionSummary.textContent = !password ? '请输入新 PDF 的打开密码' : !matches ? '两次输入的密码不一致' : `将为完整的 ${pageCount} 页 PDF 添加打开密码`;
    return;
  }
  if (operation === 'chapter') {
    const starts = chapterMode === 'manual'
      ? parseCutPoints(manualCutPoints.value, pageCount)
      : chapterMode === 'ocr'
        ? { starts: ocrItems.filter((item) => item.selected && item.page).map((item) => item.page), ranges: [], error: '' }
        : { starts: outlineItems.filter((item) => item.selected && item.page).map((item) => item.page), ranges: [], error: '' };
    const ranges = chapterMode === 'manual' ? starts.ranges : rangesFromChapterStarts(starts.starts, pageCount);
    rangeError.textContent = starts.error;
    rangeError.classList.toggle('hidden', !starts.error);
    const waitingForConfirmation = chapterMode === 'ocr' && !ocrConfirmed;
    processButton.disabled = Boolean(starts.error) || ranges.length < 2 || waitingForConfirmation;
    selectionSummary.textContent = starts.error ? '请修正切割点后继续' : ranges.length < 2 ? '至少需要两个章节起始点才能切割' : waitingForConfirmation ? '请先确认 OCR 识别出的章节定位' : `将生成 ${ranges.length} 个章节 PDF，并打包为 ZIP`;
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
    : operation === 'enhance'
      ? `将优化 ${pages.length} 个扫描页，其余 ${unaffected} 页原样保留${autoCrop.checked ? '，并逐页裁剪白边' : ''}`
    : operation === 'split'
      ? `将切开 ${pages.length} 页，保留 ${unaffected} 个单页，输出共 ${pageCount + pages.length} 页（${splitOrder === 'ltr' ? '先左后右' : '先右后左'}）`
    : operation === 'rotate'
      ? `将把 ${pages.length} 页旋转 ${rotationAngle}°，其余页面保持不变`
      : unaffected ? `将删除 ${pages.length} 页，保留 ${unaffected} 页` : '不能删除全部页面';
  if (operation === 'delete' && !unaffected) processButton.disabled = true;
}

function updateThumbnailSelection() {
  thumbnailGrid.querySelectorAll('.page-thumbnail').forEach((thumbnail) => {
    const selected = selectedPages.has(Number(thumbnail.dataset.page));
    thumbnail.classList.toggle('selected', selected && operation !== 'reorder');
    thumbnail.setAttribute('aria-pressed', String(selected));
    thumbnail.draggable = operation === 'reorder';
    const canvas = thumbnail.querySelector('canvas');
    if (canvas) canvas.style.transform = operation === 'rotate' && selected
      ? `rotate(${rotationAngle}deg) scale(${rotationAngle % 180 ? 0.72 : 1})`
      : '';
  });
  selectedCount.textContent = `已选 ${selectedPages.size} 页`;
}

function applyPageOrder() {
  const thumbnails = new Map([...thumbnailGrid.querySelectorAll('.page-thumbnail')].map((thumbnail) => [Number(thumbnail.dataset.page), thumbnail]));
  pageOrder.forEach((page) => thumbnailGrid.appendChild(thumbnails.get(page)));
  updateSelection();
}

function reorderPageBefore(sourcePage, targetPage) {
  pageOrder = movePageBefore(pageOrder, sourcePage, targetPage);
  applyPageOrder();
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
    thumbnail.addEventListener('dragstart', (event) => {
      if (operation !== 'reorder') return event.preventDefault();
      draggedPage = page;
      thumbnail.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', String(page));
    });
    thumbnail.addEventListener('dragover', (event) => {
      if (operation !== 'reorder') return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
    });
    thumbnail.addEventListener('drop', (event) => {
      if (operation !== 'reorder') return;
      event.preventDefault();
      const sourcePage = draggedPage ?? Number(event.dataTransfer.getData('text/plain'));
      reorderPageBefore(sourcePage, page);
    });
    thumbnail.addEventListener('dragend', () => {
      draggedPage = null;
      thumbnail.classList.remove('dragging');
    });
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

function renderOutlineList() {
  if (!outlineList) return;
  outlineList.replaceChildren();
  const validItems = outlineItems.filter((item) => item.page);
  outlineEmpty.classList.toggle('hidden', validItems.length > 0);
  validItems.forEach((item) => {
    const label = document.createElement('label');
    label.className = 'outline-item';
    label.style.paddingLeft = `${12 + item.depth * 20}px`;
    label.innerHTML = `<input type="checkbox" ${item.selected ? 'checked' : ''} /><span class="outline-title"></span><small>第 ${item.page} 页</small>`;
    label.querySelector('.outline-title').textContent = item.title;
    label.querySelector('input').addEventListener('change', (event) => {
      item.selected = event.target.checked;
      updateSelection();
    });
    outlineList.appendChild(label);
  });
}

function renderOcrList() {
  ocrList.replaceChildren();
  ocrItems.forEach((item) => {
    const label = document.createElement('label');
    label.className = 'outline-item';
    label.innerHTML = '<input type="checkbox" /><span class="outline-title"></span><small></small><input class="ocr-page-override" type="number" min="1" aria-label="章节 PDF 起始页" />';
    label.querySelector('input[type="checkbox"]').checked = item.selected;
    label.querySelector('.outline-title').textContent = item.title;
    label.querySelector('small').textContent = `印刷第 ${item.printedPage} 页`;
    const pageInput = label.querySelector('.ocr-page-override');
    pageInput.value = item.page || '';
    label.querySelector('input[type="checkbox"]').addEventListener('change', (event) => {
      item.selected = event.target.checked;
      ocrConfirmed = false;
      ocrConfirmButton.disabled = !ocrItems.some((candidate) => candidate.selected && candidate.page);
      updateSelection();
    });
    pageInput.addEventListener('input', (event) => {
      const page = Number(event.target.value);
      item.page = Number.isInteger(page) && page >= 1 && page <= pageCount ? page : null;
      item.selected = Boolean(item.page);
      ocrConfirmed = false;
      ocrConfirmButton.disabled = true;
      label.querySelector('input[type="checkbox"]').checked = item.selected;
      updateSelection();
    });
    ocrList.appendChild(label);
  });
}

async function runOcrChapterDetection() {
  if (!sourceBytes || !pageCount) return;
  const toc = parsePageRange(ocrTocPages.value, pageCount);
  if (toc.error || !toc.pages.length) {
    ocrStatus.textContent = toc.error || '请输入目录所在的 PDF 页。';
    return;
  }
  ocrRunButton.disabled = true;
  ocrStatus.textContent = '正在加载本地 OCR…';
  let worker;
  let tocWorker;
  try {
    tocWorker = await createTocOcrWorker((message) => {
      if (message.status) ocrStatus.textContent = `OCR 引擎：${message.status}`;
    });
    const tocTexts = [];
    for (let index = 0; index < toc.pages.length; index += 1) {
      ocrStatus.textContent = `正在识别目录 ${index + 1} / ${toc.pages.length} 页…`;
      tocTexts.push(await recognizePageText(tocWorker, sourceBytes, toc.pages[index]));
    }
    const parsedToc = tocTexts.flatMap((item) => parseTocLines(item.text));
    if (!parsedToc.length) throw new Error('没有从目录中识别出“章节名 + 页码”，请调整目录页范围或改用手动切割。');
    await tocWorker.terminate();
    tocWorker = null;
    worker = await createPageNumberOcrWorker((message) => {
      if (message.status) ocrStatus.textContent = `OCR 引擎：${message.status}`;
    });
    const pages = Array.from({ length: pageCount }, (_, index) => index + 1);
    const pageResults = await recognizePageNumbers(worker, sourceBytes, pages, ['footer', 'header'], (current, total) => {
      ocrStatus.textContent = `正在扫描正文页码 ${current} / ${total} 页…`;
    });
    const mapping = mapPrintedPagesToPdf(pageResults);
    ocrItems = parsedToc.map((item) => ({ ...item, page: mapping.get(item.printedPage) || null, selected: Boolean(mapping.get(item.printedPage)) }));
    ocrConfirmed = false;
    renderOcrList();
    ocrConfirmButton.disabled = !ocrItems.some((item) => item.selected && item.page);
    ocrStatus.textContent = `完成：目录 ${ocrItems.length} 项，定位到 ${ocrItems.filter((item) => item.page).length} 项。未定位项目可手动切割。`;
    updateSelection();
  } catch (error) {
    console.error(error);
    ocrStatus.textContent = error.message || 'OCR 失败，请改用手动切割。';
    ocrItems = [];
    ocrConfirmed = false;
    ocrConfirmButton.disabled = true;
    ocrList.replaceChildren();
    updateSelection();
  } finally {
    await tocWorker?.terminate();
    await worker?.terminate();
    ocrRunButton.disabled = false;
  }
}

function setOperation(nextOperation) {
  operation = nextOperation;
  document.querySelectorAll('.operation').forEach((button) => {
    const active = button.dataset.operation === operation;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  const usesPageSelection = operation === 'extract' || operation === 'delete' || operation === 'rotate' || operation === 'split' || operation === 'enhance';
  const usesPageBrowser = usesPageSelection || operation === 'reorder';
  rangeEditor.classList.toggle('hidden', !usesPageSelection);
  pageBrowser.classList.toggle('hidden', !usesPageBrowser);
  selectionActions.classList.toggle('hidden', !usesPageSelection);
  reorderActions.classList.toggle('hidden', operation !== 'reorder');
  pageBrowserTitle.textContent = operation === 'reorder' ? '调整页面顺序' : '页面预览';
  pageBrowserHelp.textContent = operation === 'reorder' ? '拖拽页面卡片改变顺序' : '点击选择页面，按住 Shift 可连续选择';
  splitNotice.classList.toggle('hidden', operation !== 'split');
  rotationPanel.classList.toggle('hidden', operation !== 'rotate');
  passwordPanel.classList.toggle('hidden', operation !== 'protect');
  scanPanel.classList.toggle('hidden', operation !== 'enhance');
  chapterPanel.classList.toggle('hidden', operation !== 'chapter');
  ocrChapterPanel.classList.toggle('hidden', operation !== 'chapter' || chapterMode !== 'ocr');
  rangeLabel.textContent = operation === 'extract' ? '要提取哪些页？' : operation === 'rotate' ? '要旋转哪些页？' : operation === 'split' ? '要切开哪些页？' : operation === 'enhance' ? '要优化哪些扫描页？' : '要删除哪些页？';
  processButton.innerHTML = operation === 'extract'
    ? '生成新 PDF <span aria-hidden="true">→</span>'
    : operation === 'delete'
      ? '删除并生成新 PDF <span aria-hidden="true">→</span>'
      : operation === 'unlock'
        ? '生成无使用限制副本 <span aria-hidden="true">→</span>'
        : operation === 'split'
          ? '切开并生成新 PDF <span aria-hidden="true">→</span>'
        : operation === 'rotate'
            ? '旋转并生成新 PDF <span aria-hidden="true">→</span>'
            : operation === 'protect'
              ? '加密并生成新 PDF <span aria-hidden="true">→</span>'
              : operation === 'enhance'
                ? '优化并生成新 PDF <span aria-hidden="true">→</span>'
                : operation === 'chapter'
                  ? '切割章节并下载 ZIP <span aria-hidden="true">→</span>'
                : '按当前顺序生成 <span aria-hidden="true">→</span>';
  updateThumbnailSelection();
  if ((operation === 'split' || operation === 'enhance') && selectedPages.size === 0) {
    selectedPages = new Set(Array.from({ length: pageCount }, (_, index) => index + 1));
    syncInputFromSelection();
    return;
  }
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

async function loadFile(file, password = '') {
  if (!file) return;
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    showToast('请选择 PDF 文件。');
    return;
  }
  try {
    wasRestricted = false;
    const loadedPdf = await readPdfFile(file, password);
    sourceBytes = loadedPdf.bytes;
    pageCount = loadedPdf.pageCount;
    wasRestricted = loadedPdf.wasRestricted;
    sourceFile = file;
    pendingFile = null;
    fileName.textContent = file.name;
    fileMeta.textContent = `${pageCount} 页 · ${formatSize(file.size)}${wasRestricted ? ' · 已解除使用限制' : ''}`;
    totalPages.textContent = pageCount;
    uploadCard.classList.add('hidden');
    passwordPrompt.classList.add('hidden');
    documentCard.classList.remove('hidden');
    pageRange.value = '';
    selectedPages = new Set();
    pageOrder = Array.from({ length: pageCount }, (_, index) => index + 1);
    selectionAnchor = null;
    ocrItems = [];
    ocrConfirmed = false;
    ocrStatus.textContent = '';
    ocrList.replaceChildren();
    ocrConfirmButton.disabled = true;
    outlineItems = (await readPdfOutline(sourceBytes)).map((item) => ({ ...item, selected: true }));
    renderOutlineList();
    await buildThumbnailBrowser(sourceBytes);
    setOperation(wasRestricted ? 'unlock' : 'extract');
    if (!wasRestricted) pageRange.focus();
  } catch (error) {
    console.error(error);
    pendingFile = file;
    passwordFileName.textContent = file.name;
    uploadCard.classList.add('hidden');
    documentCard.classList.add('hidden');
    passwordPrompt.classList.remove('hidden');
    openPassword.value = '';
    openPassword.focus();
    showToast(password ? '密码不正确，或该 PDF 已损坏。' : '请输入 PDF 的打开密码。');
  }
}

async function generatePdf() {
  const { pages, error } = parsePageRange(pageRange.value, pageCount);
  const requiresPages = operation === 'extract' || operation === 'delete' || operation === 'rotate' || operation === 'split' || operation === 'enhance';
  if ((requiresPages && (error || !pages.length)) || !sourceBytes) return;
  const selected = new Set(pages);
  const indices = operation === 'extract'
    ? pages.map((page) => page - 1)
    : operation === 'delete'
      ? Array.from({ length: pageCount }, (_, index) => index).filter((index) => !selected.has(index + 1))
      : operation === 'reorder'
        ? pageOrder.map((page) => page - 1)
        : Array.from({ length: pageCount }, (_, index) => index);
  if (!indices.length) return;
  processButton.disabled = true;
  processButton.textContent = '正在生成…';
  try {
    let bytes;
    if (operation === 'unlock') {
      bytes = sourceBytes;
    } else if (operation === 'protect') {
      bytes = await protectPdf(sourceBytes, newPassword.value);
    } else if (operation === 'split') {
      bytes = await splitDoublePages(sourceBytes, {
        angle: Number(deskewAngle.value),
        selectedPages: pages,
        splitRatio: Number(splitPosition.value) / 100,
        order: splitOrder,
      }, (current, total) => {
        selectionSummary.textContent = `正在处理第 ${current} / ${total} 个阅读器页面…`;
      });
    } else if (operation === 'enhance') {
      bytes = await enhanceScannedPages(sourceBytes, {
        selectedPages: pages,
        autoCrop: autoCrop.checked,
        cropPadding: Number(cropPadding.value) / 100,
        brightness: Number(scanBrightness.value),
        contrast: Number(scanContrast.value),
        grayscale: scanGrayscale.checked,
      }, (current, total) => {
        selectionSummary.textContent = `正在优化第 ${current} / ${total} 个阅读器页面…`;
      });
    } else if (operation === 'chapter') {
      const parsed = chapterMode === 'manual'
        ? parseCutPoints(manualCutPoints.value, pageCount)
        : { ranges: rangesFromChapterStarts((chapterMode === 'ocr' ? ocrItems : outlineItems).filter((item) => item.selected && item.page).map((item) => item.page), pageCount), error: '' };
      if (parsed.error || parsed.ranges.length < 2) throw new Error(parsed.error || 'At least two chapter starts are required');
      bytes = await createChapterZip(sourceBytes, parsed.ranges, sourceFile.name.replace(/\.pdf$/i, ''));
    } else if (operation === 'rotate') {
      bytes = await rotatePdfPages(sourceBytes, pages, rotationAngle);
    } else {
      bytes = await createPageSubset(sourceBytes, indices);
    }
    const stem = sourceFile.name.replace(/\.pdf$/i, '');
    const suffix = operation === 'extract' ? '提取页' : operation === 'delete' ? '已删除页' : operation === 'unlock' ? '无使用限制' : operation === 'split' ? '双页已切开' : operation === 'rotate' ? '已旋转' : operation === 'protect' ? '已加密' : operation === 'enhance' ? '扫描已优化' : '已排序';
    const isChapterZip = operation === 'chapter';
    const blob = new Blob([bytes], { type: isChapterZip ? 'application/zip' : 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const link = Object.assign(document.createElement('a'), { href: url, download: `${stem}-${isChapterZip ? '章节切割' : suffix}.${isChapterZip ? 'zip' : 'pdf'}` });
    link.click();
    URL.revokeObjectURL(url);
    showToast(operation === 'chapter' ? '章节 ZIP 已开始下载。' : operation === 'unlock' ? '无使用限制的 PDF 已开始下载。' : operation === 'split' ? '切开的 PDF 已开始下载。' : '新 PDF 已开始下载。');
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
chapterModeButtons.forEach((button) => button.addEventListener('click', () => {
  chapterMode = button.dataset.chapterMode;
  chapterModeButtons.forEach((choice) => {
    const active = choice === button;
    choice.classList.toggle('active', active);
    choice.setAttribute('aria-pressed', String(active));
  });
  outlineList.classList.toggle('hidden', chapterMode !== 'outline');
  outlineEmpty.classList.toggle('hidden', chapterMode !== 'outline' || outlineItems.some((item) => item.page));
  ocrChapterPanel.classList.toggle('hidden', chapterMode !== 'ocr');
  manualCutPointPanel.classList.toggle('hidden', chapterMode !== 'manual');
  updateSelection();
}));
ocrRunButton.addEventListener('click', runOcrChapterDetection);
ocrConfirmButton.addEventListener('click', () => {
  const starts = ocrItems.filter((item) => item.selected && item.page).map((item) => item.page);
  if (starts.length < 2) return;
  ocrConfirmed = true;
  ocrStatus.textContent = `已确认 ${starts.length} 个章节起始页，可以执行切割。`;
  updateSelection();
});
manualCutPoints.addEventListener('input', updateSelection);
newPassword.addEventListener('input', updateSelection);
confirmPassword.addEventListener('input', updateSelection);
function bindScanControl(input, output, formatter = (value) => `${value}%`) {
  input.addEventListener('input', () => { if (output) output.textContent = formatter(input.value); updateSelection(); });
}
bindScanControl(cropPadding, $('#crop-padding-value'));
bindScanControl(scanBrightness, $('#scan-brightness-value'));
bindScanControl(scanContrast, $('#scan-contrast-value'));
bindScanControl(autoCrop);
bindScanControl(scanGrayscale);
$('#open-with-password').addEventListener('click', () => { if (pendingFile && openPassword.value) loadFile(pendingFile, openPassword.value); });
openPassword.addEventListener('keydown', (event) => { if (event.key === 'Enter' && pendingFile && openPassword.value) loadFile(pendingFile, openPassword.value); });
$('#cancel-password').addEventListener('click', () => { pendingFile = null; passwordPrompt.classList.add('hidden'); uploadCard.classList.remove('hidden'); fileInput.value = ''; });
document.querySelectorAll('[data-rotation]').forEach((button) => button.addEventListener('click', () => {
  rotationAngle = Number(button.dataset.rotation);
  document.querySelectorAll('[data-rotation]').forEach((choice) => {
    const active = choice === button;
    choice.classList.toggle('active', active);
    choice.setAttribute('aria-pressed', String(active));
  });
  updateThumbnailSelection();
  updateSelection();
}));
pageRange.addEventListener('input', syncSelectionFromInput);
deskewAngle.addEventListener('input', () => { deskewValue.textContent = `${Number(deskewAngle.value).toFixed(1).replace('.0', '')}°`; updateSelection(); });
splitPosition.addEventListener('input', () => { splitPositionValue.textContent = `${splitPosition.value}%`; updateSelection(); });
document.querySelectorAll('[data-split-order]').forEach((button) => button.addEventListener('click', () => {
  splitOrder = button.dataset.splitOrder;
  document.querySelectorAll('[data-split-order]').forEach((choice) => {
    const active = choice === button;
    choice.classList.toggle('active', active);
    choice.setAttribute('aria-pressed', String(active));
  });
  updateSelection();
}));
$('#deskew-left').addEventListener('click', () => changeDeskewAngle(-0.1));
$('#deskew-right').addEventListener('click', () => changeDeskewAngle(0.1));
selectAllButton.addEventListener('click', () => { selectedPages = new Set(Array.from({ length: pageCount }, (_, index) => index + 1)); syncInputFromSelection(); pageRange.focus(); });
$('#clear-selection-button').addEventListener('click', () => { selectedPages.clear(); selectionAnchor = null; syncInputFromSelection(); });
$('#reverse-pages-button').addEventListener('click', () => { pageOrder.reverse(); applyPageOrder(); });
$('#reset-order-button').addEventListener('click', () => { pageOrder = Array.from({ length: pageCount }, (_, index) => index + 1); applyPageOrder(); });
processButton.addEventListener('click', generatePdf);
