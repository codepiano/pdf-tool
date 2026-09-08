// Detection is separate from PDF mutation so a reviewed plan is the only input
// to export. Coordinates throughout are MuPDF page coordinates (top-left).
export const compactText = (text) => text.normalize('NFKC').replace(/\\_/gu, '_').replace(/[\s\u00ad\u200b\ufeff]+/gu, '');
const overlaps = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
const rectOf = (q) => [Math.min(q[0], q[2], q[4], q[6]), Math.min(q[1], q[3], q[5], q[7]), Math.max(q[0], q[2], q[4], q[6]), Math.max(q[1], q[3], q[5], q[7])];

export function protectedCharacters(chars) {
  const text = chars.map((c) => c.text.normalize('NFKC')).join('');
  // Preserve whole common labels as well as bare Arabic, Roman and Chinese
  // numerals. Ambiguous numeric text is deliberately retained, even if supplied.
  const patterns = [
    /\b(?:page|p\.)\s*[\divxlcdm]+(?:\s*(?:of|\/)\s*[\divxlcdm]+)?\b/giu,
    /\b[\divxlcdm]+\s*(?:of|\/)\s*[\divxlcdm]+\b/giu,
    /第\s*[\d〇零一二三四五六七八九十百千万]+\s*页(?:\s*[\/／共]\s*[\d〇零一二三四五六七八九十百千万]+\s*页)?/gu,
    /(?:[\/／]\s*)?共\s*[\d〇零一二三四五六七八九十百千万]+\s*页/gu,
    /(?:\b[A-Z]-)?\p{N}+(?:\s*[\/／]\s*\p{N}+)?/gu,
    /\b[ivxlcdm]+\b/giu,
    /[〇零一二三四五六七八九十百千万]+/gu,
  ];
  // Map normalized code units back to the original glyphs, including ligatures.
  const map = chars.flatMap((c, i) => Array(c.text.normalize('NFKC').length).fill(i));
  const result = new Set();
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) {
    for (let i = match.index; i < match.index + match[0].length; i++) result.add(map[i]);
  }
  // Keep decoration adjacent to a page number, e.g. "— 23 —".
  chars.forEach((char, i) => {
    if (/^[\s\-–—·()[\]（）]+$/u.test(char.text)) result.add(i);
  });
  // Numbers inside a complete download attribution identify a resource and a
  // download date, not the printed page. Bound the exception at the date so a
  // neighboring page number is never included. Works across extracted lines.
  const downloadNotice = /\bDownloaded\s+from\s+[\s\S]*?\s+by\s+[\s\S]*?\s+on\s+\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\b/giu;
  for (const match of text.matchAll(downloadNotice)) {
    for (let i = match.index; i < match.index + match[0].length; i++) result.delete(map[i]);
  }
  return result;
}

function regionLines(lines) {
  return ['header', 'footer'].flatMap((region) => {
    const items = lines.filter((line) => line.region === region).sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
    if (!items.length) return [];
    const chars = items.flatMap((line, i) => i ? [{ text: ' ' }, ...line.chars] : line.chars);
    return [{ ...items[0], chars, protected: protectedCharacters(chars) }];
  });
}

export function inspectPage(page, number, { margin = 12, region = 'both' } = {}) {
  const bounds = page.getBounds();
  const height = bounds[3] - bounds[1];
  const lines = [];
  let line;
  let imageArea = 0;
  const structured = page.toStructuredText('preserve-whitespace,preserve-images');
  try {
    structured.walk({
      beginLine(bbox, wmode, direction) {
        line = { chars: [], bbox, horizontal: wmode === 0 && Math.abs(direction[1]) < 0.01 && direction[0] > 0.99 };
        lines.push(line);
      },
      onChar(text, origin, font, size, quad) { line.chars.push({ text, rect: rectOf(quad) }); },
      onImageBlock(bbox) { imageArea += Math.max(0, Math.min(bbox[2], bounds[2]) - Math.max(bbox[0], bounds[0])) * Math.max(0, Math.min(bbox[3], bounds[3]) - Math.max(bbox[1], bounds[1])); },
    });
  } finally { structured.destroy(); }
  const allChars = lines.flatMap((item) => item.chars);
  const result = { number, bounds, lines: [], protected: [], warning: '' };
  if (!allChars.some((c) => c.text.trim()) || imageArea >= (bounds[2] - bounds[0]) * height * 0.5) {
    result.warning = '没有可处理的文字层，或页面以扫描图为主';
    return result;
  }
  // applyRedactions applies every Redact annotation on the page. Do not commit
  // the user's pre-existing redactions as a side effect of this operation.
  if (page.getAnnotations().some((annotation) => annotation.getType() === 'Redact')) {
    result.warning = '已有待应用的涂黑标注，已跳过';
    return result;
  }
  for (const item of lines) {
    const atTop = item.bbox[1] >= bounds[1] && item.bbox[3] <= bounds[1] + height * margin / 100;
    const atBottom = item.bbox[1] >= bounds[3] - height * margin / 100 && item.bbox[3] <= bounds[3];
    if (!(atTop && region !== 'footer') && !(atBottom && region !== 'header')) continue;
    const protectedSet = protectedCharacters(item.chars);
    result.protected.push(...item.chars.filter((c, i) => protectedSet.has(i) && c.text.trim()).map((c) => c.rect));
    if (!item.horizontal) { result.warning = '部分页边文字为竖排或旋转文字，已保留'; continue; }
    item.region = atTop ? 'header' : 'footer';
    item.y = (item.bbox[1] - bounds[1]) / height;
    item.protected = protectedSet;
    // Thin inset rectangles remove entire touched glyphs without reaching into
    // neighboring glyphs. A collision with ANY retained glyph rejects the hit.
    item.chars.forEach((c) => {
      const [x0, y0, x1, y1] = c.rect;
      c.cut = [x0 + (x1 - x0) * 0.2, y0 + (y1 - y0) * 0.35, x1 - (x1 - x0) * 0.2, y1 - (y1 - y0) * 0.35];
    });
    item.allChars = allChars;
    result.lines.push(item);
  }
  return result;
}

export function pageCandidates(page, targets) {
  const candidates = [];
  const regions = regionLines(page.lines);
  // Share the context-aware protection with automatic inference and preview.
  const protectedGlyphs = new Set(regions.flatMap((line) => line.chars.filter((c, i) => line.protected.has(i))));
  page.protected = regions.flatMap((line) => line.chars.filter((c) => c.rect && c.text.trim() && protectedGlyphs.has(c)).map((c) => c.rect));
  const lines = targets.length ? regions : page.lines.map((line) => ({ ...line, protected: new Set(line.chars.map((c, i) => protectedGlyphs.has(c) ? i : -1).filter((i) => i >= 0)) }));
  for (const [lineIndex, line] of lines.entries()) {
    const map = [];
    let text = '';
    line.chars.forEach((char, index) => {
      for (const unit of compactText(char.text).split('')) { text += unit; map.push(index); }
    });
    const hits = [];
    if (targets.length) {
      for (const target of targets) {
        const needle = compactText(target);
        if (!needle) continue;
        let start = text.indexOf(needle);
        while (start !== -1) {
          hits.push({ label: target, indices: new Set(map.slice(start, start + needle.length)) });
          start = text.indexOf(needle, start + needle.length);
        }
      }
    } else {
      const indices = new Set(line.chars.map((_, i) => i).filter((i) => !line.protected.has(i)));
      const label = line.chars.map((c, i) => indices.has(i) || /^\s+$/u.test(c.text) ? c.text : '').join('').replace(/\s+/gu, ' ').trim();
      if (compactText(label).length >= 2 && /\p{L}/u.test(label)) hits.push({ label, indices });
    }
    for (const [hitIndex, hit] of hits.entries()) {
      // Whitespace/decorations are retained but don't prevent an explicit match.
      const indices = [...hit.indices].filter((i) => line.chars[i].text.trim());
      const protectedHit = indices.some((i) => line.protected.has(i) && !/^[\-–—·()[\]（）]+$/u.test(line.chars[i].text));
      const chosen = new Set(indices.map((i) => line.chars[i]));
      const cuts = [...chosen].map((c) => c.cut);
      const collisions = cuts.some((cut) => cut[0] >= cut[2] || cut[1] >= cut[3] || line.allChars.some((c) => !chosen.has(c) && c.text.trim() && overlaps(cut, c.rect)));
      if (protectedHit || collisions) {
        page.warning = '部分匹配与页码或其他文字无法可靠分离，已保留';
        continue;
      }
      const y = (Math.min(...[...chosen].map((c) => c.rect[1])) - page.bounds[1]) / (page.bounds[3] - page.bounds[1]);
      candidates.push({ id: `${page.number}:${lineIndex}:${hitIndex}`, page: page.number, label: hit.label, region: line.region, y, rects: [...chosen].map((c) => c.rect), cuts });
    }
  }
  return candidates;
}

export function buildPlan(pages, candidates, targets) {
  const groups = [];
  for (const candidate of candidates) {
    let group = groups.find((g) => g.label === candidate.label && g.region === candidate.region && Math.abs(g.y - candidate.y) < 0.02);
    if (!group) {
      group = { id: String(groups.length), label: candidate.label, region: candidate.region, y: candidate.y, pages: [] };
      groups.push(group);
    }
    candidate.groupId = group.id;
    if (!group.pages.includes(candidate.page)) group.pages.push(candidate.page);
  }
  // Three distinct pages, not occurrences: duplicate text on one page is not
  // evidence of a running header. Local chapter styles can still qualify.
  const accepted = groups.filter((g) => targets.length || g.pages.length >= 3);
  const ids = new Set(accepted.map((g) => g.id));
  const kept = candidates.filter((c) => ids.has(c.groupId));
  return {
    pages, groups: accepted, candidates: kept,
    unmatched: targets.filter((target) => !accepted.some((g) => g.label === target)),
    samples: samplePages(pages.length, accepted),
  };
}

export function samplePages(count, groups = []) {
  const samples = new Set([1, 2, Math.max(1, Math.floor(count / 2)), Math.max(1, Math.floor(count / 2) + 1), count - 1, count].filter((n) => n > 0 && n <= count));
  for (const group of groups) {
    if (samples.size >= 12) break;
    if (!group.pages.some((n) => samples.has(n))) samples.add(group.pages[0]);
  }
  return [...samples].sort((a, b) => a - b);
}

export function applyPageRemovals(page, candidates, mupdf) {
  if (!candidates.length) return;
  if (page.getAnnotations().some((annotation) => annotation.getType() === 'Redact')) throw new Error('页面含有未应用的涂黑标注，请重新分析。');
  for (const candidate of candidates) for (const cut of candidate.cuts) {
    const annotation = page.createAnnotation('Redact');
    annotation.setRect(cut);
  }
  page.applyRedactions(false, mupdf.PDFPage.REDACT_IMAGE_NONE, mupdf.PDFPage.REDACT_LINE_ART_NONE, mupdf.PDFPage.REDACT_TEXT_REMOVE);
}
