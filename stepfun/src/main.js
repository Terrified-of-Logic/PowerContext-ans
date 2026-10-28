const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const barEl = $('bar');
const outEl = $('out');
const backendEl = $('backend');
const kbEl = $('kb');

// ?device=wasm / ?device=webgpu 可强制指定端侧推理后端，用于验证「WebGPU 优先 + WASM 降级」两条路径
const FORCE_DEVICE = new URLSearchParams(location.search).get('device') || 'auto';

/* ---------------- Worker RPC ---------------- */

const worker = new Worker(new URL('./embed.worker.js', import.meta.url), { type: 'module' });
let seq = 0;
const pending = new Map();

worker.addEventListener('message', (e) => {
  const msg = e.data || {};
  if (msg.type === 'progress') {
    const p = msg.payload || {};
    if (p.status === 'progress' && typeof p.progress === 'number') {
      setStatus(`加载端侧模型 ${p.file || ''} ${p.progress.toFixed(0)}%`, false, p.progress);
    }
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

function setBackend(info) {
  const label = info.backend || (info.device === 'webgpu' ? 'WebGPU' : 'WASM');
  const dtype = info.dtype === 'q8' ? 'INT8' : String(info.dtype || '').toUpperCase();
  let text = `推理后端：${label} · ${dtype}`;
  if (info.fallbackReason) text += `（${info.fallbackReason}）`;
  backendEl.textContent = text;
  backendEl.className = 'badge ' + (info.device === 'webgpu' ? 'gpu' : 'cpu');
}

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

/* ---------------- 知识库状态（seekdb 中持久化，刷新/重启后读回） ---------------- */

async function refreshStats() {
  try {
    const r = await fetch('/api/stats');
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'stats 失败');
    const files = j.files || [];
    kbEl.textContent =
      `知识库：${j.docs} 块 / ${files.length} 个文件` +
      (files.length ? `（${files.map((f) => `${f.docId}×${f.chunks}`).join('、')}）` : '') +
      ` · 向量索引=${j.vectorIndex} · 关键词路=${j.keyword} · 混合=${j.hybrid}`;
    return j;
  } catch (e) {
    kbEl.textContent = '知识库：无法读取状态（' + e.message + '）';
    return null;
  }
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

    // 分批向量化，每批 16 条：减少 Worker 消息往返、摊薄单次调用开销
    const BATCH = 16;
    const records = [];
    let embedMsSum = 0;
    for (let i = 0; i < chunks.length; i += BATCH) {
      const batch = chunks.slice(i, i + BATCH);
      setStatus(`向量化 ${f.name} ${i}/${chunks.length} 段（端侧推理）`);
      const { vectors, dim, ms } = await call('embed', { texts: batch });
      embedMsSum += ms;
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

    const t1 = performance.now();
    const r = await fetch('/api/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ records }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || '入库失败');
    total += j.inserted;
    const ms = performance.now() - t1;
    setStatus(
      `${f.name} 入库 ${j.inserted} 块（替换旧块 ${j.replaced}）· 端侧向量化 ${embedMsSum.toFixed(0)}ms` +
        `（${(embedMsSum / chunks.length).toFixed(1)}ms/块）· seekdb 写入+可见校验 ${ms.toFixed(0)}ms（累计 ${total}）`,
      true,
      100
    );
    await refreshStats();
  }

  outEl.innerHTML = `<div class="empty">已入库 ${total} 个文本块（同文件重复上传会替换旧块），可以开始检索了</div>`;
}

/* ---------------- 检索 ---------------- */

// BGE 系列模型对「查询」需要指令前缀，否则检索效果明显下降
// 文档侧不加前缀，查询侧加，这是非对称检索的标准做法
const QUERY_PREFIX = '为这个句子生成表示以用于检索相关文章：';

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
    const e2eMs = performance.now() - t0;

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
          向量距离 ${Number(h.dist).toFixed(4)} · 全文相关度 ${Number(h.kw_hits).toFixed(4)} · RRF 融合分 ${Number(h.score).toFixed(6)}
        </div>
        <div>${highlight(h.content, terms)}</div>
      </div>`
      )
      .join('');

    setStatus(
      `端侧向量化 ${embedMs.toFixed(0)}ms · seekdb 混合检索 ${searchMs.toFixed(0)}ms（单条 SQL：${j.hybrid}）· 端到端 ${e2eMs.toFixed(0)}ms · 命中 ${j.hits.length} 条`,
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
  await refreshStats();
  try {
    setStatus('正在加载端侧模型（首次约 25–45 MB，之后走浏览器缓存）…', false, 0);
    const r = await call('load', { device: FORCE_DEVICE });
    setBackend(r);
    setStatus(
      `模型就绪（${r.dim} 维 · ${r.backend} · ${r.dtype === 'q8' ? 'INT8' : r.dtype.toUpperCase()}）` +
        ` · 加载 ${(r.loadMs / 1000).toFixed(1)}s · 预热 ${r.warmMs.toFixed(0)}ms，可以上传文件了`,
      true,
      100
    );
  } catch (e) {
    setStatus('模型加载失败：' + e.message);
  }
})();
