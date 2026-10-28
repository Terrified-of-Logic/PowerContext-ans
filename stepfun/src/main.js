const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const backendEl = $('backend');
const barEl = $('bar');
const outEl = $('out');

/** 推理后端必须对用户可见（验收项「后端与降级」要求明确提示） */
function renderBackend(info) {
  if (!info) return;
  const isGpu = info.backend === 'webgpu';
  backendEl.className = 'backend ' + (isGpu ? 'gpu' : 'warn');
  backendEl.textContent = isGpu
    ? `推理后端：WebGPU（${info.detail || 'GPU 加速' }）`
    : `推理后端：WASM · 已自动降级 —— ${info.detail || '当前环境不支持 WebGPU'}`;
}

/* ---------------- Worker RPC ---------------- */

const worker = new Worker(new URL('./embed.worker.js', import.meta.url), { type: 'module' });
let seq = 0;
const pending = new Map();

worker.addEventListener('message', (e) => {
  const msg = e.data || {};
  if (msg.type === 'progress') {
    const p = msg.payload || {};
    if (p.status === 'progress' && typeof p.progress === 'number') {
      setStatus(`下载模型中 ${p.file || ''} ${p.progress.toFixed(0)}%`, false, p.progress);
    }
    return;
  }
  if (msg.type === 'backend') {
    renderBackend(msg.payload);
    return;
  }
  const resolver = pending.get(msg.id);
  if (!resolver) return;
  pending.delete(msg.id);
  msg.ok ? resolver.resolve(msg) : resolver.reject(new Error(msg.error));
});

worker.addEventListener('error', (e) => {
  setStatus('Worker 出错：' + (e.message || '未知错误'), false, 0);
});

function call(type, payload) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, type, payload });
  });
}

/* ---------------- UI helpers ---------------- */

function setStatus(text, ok = false, progress = null) {
  statusEl.textContent = text;
  statusEl.classList.toggle('ok', ok);
  if (progress !== null) barEl.style.width = String(progress) + '%';
}

/* ---------------- 分块 ---------------- */

function chunkText(text, { max = 400, min = 40 } = {}) {
  const clean = text
    .replace(/\r\n/g, '\n')
    // 标题前后都断开，让「## 二、向量索引」独立成段，不和正文粘连
    .replace(/(#{1,6}\s[^\n]*)\n/g, '$1\n\n')
    .replace(/\n(#{1,6}\s)/g, '\n\n$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const paras = clean.split(/\n{2,}/);
  const chunks = [];

  for (const para of paras) {
    const p = para.trim();
    if (!p) continue;
    // 纯标题块丢掉：没有信息量，只会稀释相似度
    if (/^#{1,6}\s/.test(p) && p.length < 20) continue;

    if (p.length <= max) {
      chunks.push(p);
      continue;
    }

    // 长段按句末标点切，保留标点
    const sentences = p.match(/[^。！？!?；;\n]+[。！？!?；;]?/g) || [p];
    let buf = '';
    for (const s of sentences) {
      if ((buf + s).length <= max) {
        buf += s;
      } else {
        if (buf.trim()) chunks.push(buf.trim());
        buf = s.length > max ? s.slice(0, max) : s;
      }
    }
    if (buf.trim()) chunks.push(buf.trim());
  }

  // 过短的残片不要：会拉低检索质量（实测比加重叠更重要）
  return chunks.filter((c) => c.length >= min);
}

/* ---------------- 入库 ---------------- */

async function ingestFiles(files) {
  const list = Array.from(files).filter((f) => /\.(txt|md)$/i.test(f.name));
  if (!list.length) {
    setStatus('只支持 .txt / .md 文件');
    return;
  }

  let total = 0;
  for (let fi = 0; fi < list.length; fi++) {
    const f = list[fi];
    setStatus(`读取 ${f.name}（${fi + 1}/${list.length}）`);
    const text = await f.text();
    const chunks = chunkText(text);

    if (!chunks.length) continue;

    // 分批向量化，每批 16 条
    const BATCH = 16;
    const records = [];
    for (let i = 0; i < chunks.length; i += BATCH) {
      const batch = chunks.slice(i, i + BATCH);
      setStatus(`向量化 ${f.name} ${i}/${chunks.length} 段（端侧推理）`);
      const { vectors, dim, ms } = await call('embed', { texts: batch });
      if (dim !== 512) console.warn('维度异常', dim);
      batch.forEach((content, k) => {
        records.push({
          doc_id: f.name,
          chunk_index: i + k,
          title: `${f.name} #${i + k + 1}`,
          content,
          vector: vectors[k],
        });
      });
      console.log(`[embed] ${batch.length} 段 ${ms.toFixed(0)}ms`);
    }

    const r = await fetch('/api/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ records }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || '入库失败');
    total += j.inserted;
    setStatus(`${f.name} 入库 ${j.inserted} 段（累计 ${total}）`, true, 100);
  }

  outEl.innerHTML = `<div class="empty">已入库 ${total} 个文本块，可以开始检索了</div>`;
}

/* ---------------- 检索 ---------------- */

// BGE 系列模型对「查询」需要指令前缀，否则检索效果明显下降
// 文档侧不加前缀，查询侧加，这是非对称检索的标准做法
const QUERY_PREFIX = '为这个句子生成表示以用于检索相关文章：';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function highlight(text, terms) {
  let html = esc(text);
  for (const t of terms) {
    if (!t) continue;
    const re = new RegExp(esc(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    html = html.replace(re, (m) => `<mark>${m}</mark>`);
  }
  return html;
}

async function search() {
  const q = $('q').value.trim();
  if (!q) return;
  $('go').disabled = true;
  setStatus('查询向量化中（端侧）…');

  try {
    const t0 = performance.now();
    const { vectors } = await call('embed', { texts: [QUERY_PREFIX + q] });
    const embedMs = performance.now() - t0;

    const t1 = performance.now();
    const r = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q, vector: vectors[0], topk: 8 }),
    });
    const j = await r.json();
    const searchMs = performance.now() - t1;

    if (!r.ok) throw new Error(j.error || '检索失败');

    if (!j.hits?.length) {
      outEl.innerHTML = '<div class="empty">没有命中，先上传文件入库</div>';
      setStatus(`端侧向量化 ${embedMs.toFixed(0)}ms · 检索 ${searchMs.toFixed(0)}ms`);
      return;
    }

    const terms = q.split(/\s+/).filter(Boolean);
    outEl.innerHTML = j.hits
      .map(
        (h, i) => `
      <div class="hit">
        <h3>${i + 1}. ${esc(h.title)}</h3>
        <div class="meta">
          向量距离 ${Number(h.dist).toFixed(4)} · 关键词命中 ${h.kw_hits} 次 · 融合分 ${Number(h.score).toFixed(6)}
        </div>
        <div>${highlight(h.content, terms)}</div>
      </div>`
      )
      .join('');

    setStatus(
      `端侧向量化 ${embedMs.toFixed(0)}ms · seekdb 检索 ${searchMs.toFixed(0)}ms · 命中 ${j.hits.length} 条`,
      true,
      100
    );
  } catch (e) {
    setStatus('检索失败：' + e.message);
    outEl.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  } finally {
    $('go').disabled = false;
  }
}

/* ---------------- 事件 ---------------- */

$('pick').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', (e) => ingestFiles(e.target.files));

const drop = $('drop');
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('hover'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('hover'); }));
drop.addEventListener('drop', (e) => ingestFiles(e.dataTransfer.files));

$('go').addEventListener('click', search);
$('q').addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });

/* ---------------- 启动 ---------------- */

(async () => {
  try {
    setStatus('正在加载端侧模型（首次约 25–40 MB，之后走浏览器缓存）…', false, 0);
    const r = await call('load', {});
    renderBackend({ backend: r.backend, degraded: r.backend !== 'webgpu', detail: r.backend === 'webgpu' ? 'WebGPU 加速已启用' : '当前环境不支持 WebGPU，使用 WASM' });
    setStatus(
      `模型就绪（${r.dim} 维，q8/INT8 量化）· 加载 ${(r.loadMs / 1000).toFixed(1)}s · 预热 ${r.warmMs.toFixed(0)}ms，可以上传文件了`,
      true,
      100
    );
  } catch (e) {
    setStatus('模型加载失败：' + e.message);
  }
})();
