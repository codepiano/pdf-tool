import { zipSync, strToU8 } from 'fflate';
import { PDFDocument } from 'pdf-lib';

export function parseCutPoints(value, pageCount) {
  const raw = value.trim();
  if (!raw) return { starts: [], ranges: [], error: '请输入至少一个章节起始页。' };
  if (!/^[\d\s,，]+$/.test(raw)) return { starts: [], ranges: [], error: '切割点只能使用页码和逗号。' };
  const numbers = raw.split(/[,，]/).map((item) => Number(item.trim()));
  if (numbers.some((page) => !Number.isInteger(page) || page < 1 || page > pageCount)) {
    return { starts: [], ranges: [], error: `切割点必须在 1-${pageCount} 页之间。` };
  }
  const starts = [...new Set([1, ...numbers])].sort((a, b) => a - b);
  const ranges = starts.map((start, index) => ({ start, end: (starts[index + 1] || pageCount + 1) - 1 }));
  return { starts, ranges, error: '' };
}

export function rangesFromChapterStarts(starts, pageCount) {
  const normalized = [...new Set([1, ...starts])].filter((page) => page >= 1 && page <= pageCount).sort((a, b) => a - b);
  return normalized.map((start, index) => ({ start, end: (normalized[index + 1] || pageCount + 1) - 1 }));
}

export function rangesFromChapterItems(items, pageCount) {
  const selected = items.filter((item) => item.selected && Number.isInteger(item.page) && item.page >= 1 && item.page <= pageCount)
    .sort((a, b) => a.page - b.page);
  if (selected.some((item, index) => index > 0 && item.page === selected[index - 1].page)) {
    return { ranges: [], error: '章节起始页不能重复。' };
  }
  const ranges = selected.map((item, index) => {
    const nextStart = selected[index + 1]?.page || pageCount + 1;
    const end = Number.isInteger(item.end) ? item.end : nextStart - 1;
    return { start: item.page, end };
  });
  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index];
    if (range.end < range.start || range.end > pageCount || (ranges[index + 1] && range.end >= ranges[index + 1].start)) {
      return { ranges: [], error: '章节结束页必须不小于起始页，且不能覆盖下一个章节。' };
    }
  }
  return { ranges, error: '' };
}

function safeFileName(value, fallback) {
  const cleaned = String(value || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  return (cleaned || fallback).slice(0, 100);
}

export async function createChapterZip(bytes, ranges, stem) {
  const source = await PDFDocument.load(bytes);
  const files = {};
  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index];
    const output = await PDFDocument.create();
    const pages = Array.from({ length: range.end - range.start + 1 }, (_, offset) => range.start - 1 + offset);
    const copied = await output.copyPages(source, pages);
    copied.forEach((page) => output.addPage(page));
    files[`${safeFileName(stem, 'document')}-chapter-${String(index + 1).padStart(2, '0')}-${range.start}-${range.end}.pdf`] = await output.save();
  }
  files['README.txt'] = strToU8(`本压缩包由页裁按阅读器页码切割生成。\n共 ${ranges.length} 个章节文件。\n`);
  return zipSync(files, { level: 6 });
}
