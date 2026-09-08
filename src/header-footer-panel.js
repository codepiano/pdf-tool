export function createHeaderFooterPanel(onChange) {
  const $ = (id) => document.getElementById(id);
  const panel = $('header-footer-panel');
  const status = $('hf-status');
  const preview = $('hf-preview');
  const groups = $('hf-groups');
  const samples = $('hf-samples');
  const matches = $('hf-page-matches');
  let worker;
  let workerReady;
  let plan;
  let busy = false;
  let requestId = 0;
  let version = 0;
  let previewVersion = 0;
  let currentPage = 1;
  let imageUrl;
  let enabled = new Set();
  const requests = new Map();

  function selected() { return plan?.candidates.filter((c) => enabled.has(c.id)) || []; }
  async function call(type, payload) {
    await workerReady;
    if (!worker) throw new Error('操作已取消');
    const id = ++requestId;
    return new Promise((resolve, reject) => { requests.set(id, { resolve, reject }); worker.postMessage({ id, type, payload }); });
  }
  function setBusy(value) {
    busy = value;
    panel.querySelectorAll('input, textarea, select, button').forEach((element) => { element.disabled = value; });
    $('hf-cancel').disabled = !value;
    $('hf-cancel').classList.toggle('hidden', !value);
    onChange();
  }
  function reset(message = '填写要移除的文字，或留空自动推断，然后开始分析。') {
    version++;
    previewVersion++;
    worker?.terminate();
    worker = null;
    for (const request of requests.values()) request.reject(new Error('操作已取消'));
    requests.clear();
    plan = null;
    enabled.clear();
    URL.revokeObjectURL(imageUrl);
    imageUrl = null;
    for (const element of [preview, groups, samples, matches]) element.replaceChildren();
    $('hf-results').classList.add('hidden');
    status.textContent = message;
    setBusy(false);
  }
  function createWorker() {
    worker = new Worker(new URL('./pdf/header-footer.worker.js', import.meta.url), { type: 'module' });
    workerReady = new Promise((resolve, reject) => { requests.set('ready', { resolve, reject }); });
    worker.onmessage = ({ data }) => {
      if (data.ready) { requests.get('ready')?.resolve(); requests.delete('ready'); return; }
      const request = requests.get(data.id);
      if (!request) return;
      if (data.progress) { status.textContent = data.progress; return; }
      requests.delete(data.id);
      if (data.error) request.reject(new Error(data.error));
      else request.resolve(data.result);
    };
    worker.onerror = () => {
      for (const request of requests.values()) request.reject(new Error('文字处理引擎加载或运行失败，请重试。'));
      requests.clear();
    };
  }
  function summary() {
    const chosen = selected();
    return busy ? '正在处理页眉页脚…' : !plan ? '请先分析并查看抽样预览' : `已选 ${chosen.length} 处文字，涉及 ${new Set(chosen.map((c) => c.page)).size} 页；保留页码和页面顺序`;
  }
  function refreshMarks() {
    preview.querySelectorAll('.hf-mark').forEach((mark) => mark.remove());
    matches.replaceChildren();
    const info = plan.pages[currentPage - 1];
    const [x, y, x1, y1] = info.bounds;
    function mark(rect, kind) {
      const span = document.createElement('span');
      span.className = `hf-mark ${kind}`;
      span.style.cssText = `left:${100 * (rect[0] - x) / (x1 - x)}%;top:${100 * (rect[1] - y) / (y1 - y)}%;width:${100 * (rect[2] - rect[0]) / (x1 - x)}%;height:${100 * (rect[3] - rect[1]) / (y1 - y)}%`;
      preview.appendChild(span);
    }
    info.protected.forEach((rect) => mark(rect, 'hf-keep'));
    for (const candidate of plan.candidates.filter((c) => c.page === currentPage)) {
      if (enabled.has(candidate.id)) candidate.rects.forEach((rect) => mark(rect, 'hf-remove'));
      const label = document.createElement('label');
      const checkbox = Object.assign(document.createElement('input'), { type: 'checkbox', checked: enabled.has(candidate.id) });
      checkbox.addEventListener('change', () => {
        checkbox.checked ? enabled.add(candidate.id) : enabled.delete(candidate.id);
        renderGroups(); refreshMarks(); onChange();
      });
      label.append(checkbox, document.createTextNode(`本页：${candidate.label}`));
      matches.appendChild(label);
    }
    if (!matches.childElementCount) matches.textContent = info.warning || '本页没有待移除的匹配。';
    $('hf-page-caption').textContent = `第 ${currentPage} / ${plan.pages.length} 页${info.warning ? ` · ${info.warning}` : ''}`;
  }
  async function showPage(number) {
    if (!plan) return;
    if (!Number.isInteger(number) || number < 1 || number > plan.pages.length) {
      status.textContent = `请输入 1–${plan.pages.length} 之间的整数页码。`;
      return;
    }
    const token = ++previewVersion;
    try {
      const result = await call('preview', { page: number });
      if (token !== previewVersion) return;
      const nextUrl = URL.createObjectURL(new Blob([result.png], { type: 'image/png' }));
      const img = new Image();
      img.src = nextUrl;
      img.alt = `第 ${number} 页，红色标出待移除文字，绿色标出保留的页码或数字`;
      try { await img.decode(); } catch (error) { URL.revokeObjectURL(nextUrl); throw error; }
      if (token !== previewVersion) { URL.revokeObjectURL(nextUrl); return; }
      URL.revokeObjectURL(imageUrl);
      imageUrl = nextUrl;
      currentPage = number;
      $('hf-page').value = number;
      preview.replaceChildren(img);
      refreshMarks();
    } catch (error) { if (token === previewVersion) status.textContent = error.message; }
  }
  function renderGroups() {
    groups.replaceChildren();
    for (const group of plan.groups) {
      const items = plan.candidates.filter((c) => c.groupId === group.id);
      const count = items.filter((c) => enabled.has(c.id)).length;
      const row = document.createElement('div');
      const label = document.createElement('label');
      const checkbox = Object.assign(document.createElement('input'), { type: 'checkbox', checked: count === items.length, indeterminate: count > 0 && count < items.length });
      checkbox.addEventListener('change', () => {
        items.forEach((c) => checkbox.checked ? enabled.add(c.id) : enabled.delete(c.id));
        refreshMarks(); onChange();
      });
      label.append(checkbox, document.createTextNode(`${group.region === 'header' ? '页眉' : '页脚'} · ${group.label} · ${group.pages.length} 页`));
      const button = Object.assign(document.createElement('button'), { type: 'button', className: 'text-button', textContent: '查看样本' });
      button.addEventListener('click', () => showPage(group.pages[0]));
      row.append(label, button); groups.appendChild(row);
    }
  }
  async function analyze(bytes) {
    if (!bytes || busy) return;
    reset();
    const token = version;
    createWorker();
    setBusy(true);
    status.textContent = '正在加载文字处理引擎…';
    try {
      plan = await call('analyze', { bytes: new Uint8Array(bytes).slice(), text: $('hf-text').value, margin: Number($('hf-margin').value), region: $('hf-region').value });
      if (token !== version) return;
      enabled = new Set(plan.candidates.map((c) => c.id));
      renderGroups();
      $('hf-page').max = plan.pages.length;
      $('hf-results').classList.remove('hidden');
      for (const number of plan.samples) {
        const button = Object.assign(document.createElement('button'), { className: 'choice-button', type: 'button', textContent: `第 ${number} 页` });
        button.addEventListener('click', () => showPage(number)); samples.appendChild(button);
      }
      const warnings = plan.pages.filter((p) => p.warning);
      $('hf-warnings').textContent = warnings.length ? `有 ${warnings.length} 页存在保留或跳过的内容，可输入页码检查：${warnings.map((p) => p.number).join('、')}` : '';
      status.textContent = `${plan.candidates.length ? '分析完成。可取消整组或本页的匹配，然后生成 PDF。' : '没有可安全移除的匹配；未删除任何内容。'}${plan.unmatched.length ? ` 未匹配或需保留：${plan.unmatched.join('、')}。不会改用自动推断。` : ''}`;
      await showPage(plan.samples[0]);
    } catch (error) { if (token === version) status.textContent = error.message; }
    finally { if (token === version) setBusy(false); }
  }
  for (const id of ['hf-text', 'hf-margin', 'hf-region']) $(id).addEventListener('input', () => reset('设置已修改，请重新分析。'));
  $('hf-cancel').addEventListener('click', () => reset('已取消，可重新开始分析。'));
  $('hf-show-page').addEventListener('click', () => showPage(Number($('hf-page').value)));
  $('hf-page').addEventListener('keydown', (event) => { if (event.key === 'Enter') showPage(Number(event.target.value)); });
  return {
    reset, analyze, summary,
    get busy() { return busy; },
    get ready() { return !busy && selected().length > 0; },
    async export() {
      if (busy || !selected().length) throw new Error('请先分析并选择待移除的文字。');
      setBusy(true);
      const token = version;
      try { const bytes = await call('export', { ids: selected().map((c) => c.id) }); status.textContent = '处理完成，已生成新副本。'; return bytes; }
      finally { if (token === version) setBusy(false); }
    },
  };
}
