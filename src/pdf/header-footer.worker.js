import * as mupdf from 'mupdf';
import { applyPageRemovals, buildPlan, compactText, inspectPage, pageCandidates } from './header-footer.js';

let source;
let document;
let plan;
const pause = () => new Promise((resolve) => setTimeout(resolve, 0));

self.onmessage = async ({ data: { id, type, payload } }) => {
  try {
    let result;
    if (type === 'analyze') {
      source = payload.bytes;
      document?.destroy();
      document = mupdf.Document.openDocument(source, 'application/pdf');
      const targets = [...new Map(payload.text.split(/\r?\n/u).filter((text) => compactText(text)).map((text) => [compactText(text), text.trim()])).values()];
      const pages = [];
      const candidates = [];
      for (let number = 1; number <= document.countPages(); number++) {
        const page = document.loadPage(number - 1);
        try {
          const info = inspectPage(page, number, payload);
          candidates.push(...pageCandidates(info, targets));
          // Retain only margin geometry; release body glyphs after each page.
          pages.push({ number, bounds: info.bounds, protected: info.protected, warning: info.warning });
        } finally { page.destroy(); }
        self.postMessage({ id, progress: `正在分析 ${number} / ${document.countPages()} 页…` });
        await pause();
      }
      plan = buildPlan(pages, candidates, targets);
      result = plan;
    } else if (type === 'preview') {
      if (!plan || !Number.isInteger(payload.page) || payload.page < 1 || payload.page > plan.pages.length) throw new Error('请输入有效的 PDF 页码。');
      const page = document.loadPage(payload.page - 1);
      let pixmap;
      try {
        const bounds = page.getBounds();
        const scale = Math.min(1.5, 1000 / Math.max(bounds[2] - bounds[0], bounds[3] - bounds[1]));
        pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false);
        result = { png: pixmap.asPNG(), bounds };
      } finally { pixmap?.destroy(); page.destroy(); }
    } else if (type === 'export') {
      if (!plan) throw new Error('请先分析页眉页脚。');
      const ids = new Set(payload.ids);
      const chosen = plan.candidates.filter((c) => ids.has(c.id));
      if (!chosen.length) throw new Error('没有选中的待移除文字。');
      const output = mupdf.Document.openDocument(source, 'application/pdf');
      try {
        const numbers = [...new Set(chosen.map((c) => c.page))];
        for (const [index, number] of numbers.entries()) {
          const page = output.loadPage(number - 1);
          try { applyPageRemovals(page, chosen.filter((c) => c.page === number), mupdf); }
          finally { page.destroy(); }
          self.postMessage({ id, progress: `正在移除 ${index + 1} / ${numbers.length} 个匹配页的文字…` });
          await pause();
        }
        const buffer = output.saveToBuffer('garbage=4,compress');
        try { result = buffer.asUint8Array().slice(); }
        finally { buffer.destroy(); }
      } finally { output.destroy(); }
    } else throw new Error('未知操作。');
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({ id, error: error.message || String(error) });
  }
};

// MuPDF initializes WASM with top-level await. The UI waits for this handshake
// before sending work, so the first request cannot arrive before the handler.
self.postMessage({ ready: true });
