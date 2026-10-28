// End-to-end API smoke test: local embedding (browser-equivalent model) -> /api/ingest -> /api/search.
// Assumes server is running: node server/index.mjs (embedded or SEEKDB_REMOTE=1)
// Usage: node scripts/smoke-api.mjs [apiBase] [rounds]
import { pipeline, env } from '@huggingface/transformers';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
env.allowLocalModels = false;
env.useBrowserCache = false;
env.useFSCache = true;
env.cacheDir = resolve(ROOT, '.cache');
env.remoteHost = 'https://modelscope.cn/models';
env.remotePathTemplate = '{model}/resolve/master/';

const API = process.argv[2] || 'http://127.0.0.1:8787';
const ROUNDS = Number(process.argv[3] || 3);
const MODEL = 'onnx-community/bge-small-zh-v1.5-ONNX';
const PREFIX = '为这个句子生成表示以用于检索相关文章：';
const DTYPE = process.env.DTYPE || 'q8';

function chunkText(text, { max = 400, min = 40 } = {}) {
  const clean = text
    .replace(/\r\n/g, '\n')
    .replace(/(#{1,6}\s[^\n]*)\n/g, '$1\n\n')
    .replace(/\n(#{1,6}\s)/g, '\n\n$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const paras = clean.split(/\n{2,}/);
  const chunks = [];
  for (const para of paras) {
    const p = para.trim();
    if (!p) continue;
    if (/^#{1,6}\s/.test(p) && p.length < 20) continue;
    if (p.length <= max) { chunks.push(p); continue; }
    const sentences = p.match(/[^。！？!?；;\n]+[。！？!?；;]?/g) || [p];
    let buf = '';
    for (const s of sentences) {
      if ((buf + s).length <= max) buf += s;
      else { if (buf.trim()) chunks.push(buf.trim()); buf = s.length > max ? s.slice(0, max) : s; }
    }
    if (buf.trim()) chunks.push(buf.trim());
  }
  return chunks.filter((c) => c.length >= min);
}

const json = async (path, init) => {
  const r = await fetch(API + path, init);
  const body = await r.json();
  if (!r.ok) throw new Error(path + ' ' + r.status + ': ' + JSON.stringify(body).slice(0, 300));
  return body;
};

const main = async () => {
  const tLoad = performance.now();
  const extractor = await pipeline('feature-extraction', MODEL, { dtype: DTYPE, progress_callback: () => {} });
  const loadMs = performance.now() - tLoad;
  const embed = async (texts) => {
    const t = performance.now();
    const out = await extractor(texts, { pooling: 'cls', normalize: true });
    const [n, dim] = out.dims;
    const flat = Array.from(out.data);
    const vectors = [];
    for (let i = 0; i < n; i++) vectors.push(flat.slice(i * dim, (i + 1) * dim));
    return { vectors, dim, ms: performance.now() - t };
  };
  await embed(['预热']);

  const health0 = await json('/api/health');
  console.log('[health]', JSON.stringify(health0));

  const chunks = chunkText(readFileSync(resolve(ROOT, 'demo-doc.md'), 'utf8'));
  const docEmbed = await embed(chunks);
  const records = chunks.map((content, i) => ({
    doc_id: 'demo-doc.md',
    chunk_index: i,
    title: `demo-doc.md #${i + 1}`,
    content,
    vector: docEmbed.vectors[i],
  }));

  const tIngest = performance.now();
  const ing = await json('/api/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ records }),
  });
  const ingestMs = performance.now() - tIngest;
  console.log('[ingest]', JSON.stringify(ing), 'clientMs=', ingestMs.toFixed(0));

  const stats = await json('/api/stats');
  console.log('[stats]', JSON.stringify(stats));

  const queries = [
    { q: '向量索引怎么建', expect: 'HNSW 向量索引' },
    { q: 'RRF 是什么', expect: 'RRF 的好处' },
    { q: '混合检索怎么融合两路结果', expect: '混合检索把两路' },
    { q: '量化之后模型体积和性能怎么变', expect: '量化到 8 位整数' },
  ];
  const results = [];
  for (const { q, expect } of queries) {
    const times = [];
    let last = null;
    for (let i = 0; i < ROUNDS; i++) {
      const t0 = performance.now();
      const emb = await embed([PREFIX + q]);
      const t1 = performance.now();
      const s = await json('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q, vector: emb.vectors[0], topk: 8 }),
      });
      const t2 = performance.now();
      last = s;
      times.push({ embedMs: t1 - t0, searchMs: t2 - t1, e2eMs: t2 - t0 });
    }
    const hit = (last.hits || []).findIndex((h) => String(h.content).includes(expect)) + 1;
    const median = (arr) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
    results.push({
      query: q,
      expect,
      rank: hit,
      hybrid: last.hybrid,
      keywordMode: last.keywordMode,
      hits: last.hits.length,
      embedMsMed: +median(times.map((x) => x.embedMs)).toFixed(1),
      searchMsMed: +median(times.map((x) => x.searchMs)).toFixed(1),
      e2eMsMed: +median(times.map((x) => x.e2eMs)).toFixed(1),
      top3: last.hits.slice(0, 3).map((h) => ({ title: h.title, dist: +Number(h.dist).toFixed(3), ft: +Number(h.kw_hits).toFixed(3), score: +Number(h.score).toFixed(5) })),
    });
    console.log('[search]', JSON.stringify(results[results.length - 1]));
  }

  const outDir = resolve(ROOT, 'eval', 'out');
  mkdirSync(outDir, { recursive: true });
  const payload = {
    api: API,
    dtype: DTYPE,
    engine: health0.version,
    vectorIndex: health0.vectorIndex,
    keywordMode: health0.keyword,
    chunks: chunks.length,
    loadMs: +loadMs.toFixed(0),
    docEmbedMs: +docEmbed.ms.toFixed(0),
    ingest: { ...ing, clientMs: +ingestMs.toFixed(0) },
    results,
  };
  writeFileSync(resolve(outDir, 'e2e-api.json'), JSON.stringify(payload, null, 2));
  console.log('written', resolve(outDir, 'e2e-api.json'));
};

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
