export function parsePageRange(value, pageCount) {
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

export function formatPageRange(pages) {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const ranges = [];
  for (let index = 0; index < sorted.length; index += 1) {
    const start = sorted[index];
    let end = start;
    while (index + 1 < sorted.length && sorted[index + 1] === end + 1) {
      index += 1;
      end = sorted[index];
    }
    ranges.push(start === end ? String(start) : `${start}-${end}`);
  }
  return ranges.join(', ');
}
