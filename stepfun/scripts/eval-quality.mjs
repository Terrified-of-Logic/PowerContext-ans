// StepFun embedding quality / latency evaluation: fp32 baseline vs q8 (INT8) vs fp16.
// Reproduces the numbers used in TECH_REPORT.md §量化对比 and §检索质量.
//
// Run from stepfun/ directory (after `npm install`):
//   node scripts/eval-quality.mjs                # fp32 + q8 (Node/CPU)
//   node scripts/eval-quality.mjs fp32 q8 fp16   # explicit dtypes
//
// The corpus is demo-doc.md chunked with the same rules as src/main.js;
// ground truth of the 8 queries is the chunk that contains a marker phrase.
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

const MODEL = 'onnx-community/bge-small-zh-v1.5-ONNX';
const PREFIX = '为这个句子生成表示以用于检索相关文章：';
const outDir = resolve(ROOT, 'eval', 'out');
mkdirSync(outDir, { recursive: true });

// ---------- corpus: chunk demo-doc.md (same rules as src/main.js) ----------
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

const doc = readFileSync(resolve(ROOT, 'demo-doc.md'), 'utf8');
const chunks = chunkText(doc).map((content, i) => ({ id: i, content }));

// Ground truth: query -> phrase that must appear in the relevant chunk.
const queries = [
  ['向量索引怎么建', 'HNSW 向量索引'],
  ['RRF 是什么', 'RRF 的好处'],
  ['为什么要把推理放进 Web Worker', 'Web Worker'],
  ['量化之后模型体积和性能怎么变', '量化到 8 位整数'],
  ['seekdb 嵌入式模式有什么好处', '嵌入式模式的价值'],
  ['混合检索怎么融合两路结果', '混合检索把两路'],
  ['浏览器里怎么跑端侧推理', 'Transformers.js 配合'],
  ['HNSW 索引在受限环境怎么办', '不允许创建 HNSW 索引'],
];

const truth = queries.map(([q, needle]) => {
  const idx = chunks.findIndex((c) => c.content.includes(needle));
  if (idx < 0) throw new Error('no chunk contains ' + needle);
  return { q, needle, idx };
});

const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

async function run(dtype) {
  const t0 = performance.now();
  const ex = await pipeline('feature-extraction', MODEL, { dtype, progress_callback: () => {} });
  const loadMs = performance.now() - t0;
  const embed = async (texts) => {
    const out = await ex(texts, { pooling: 'cls', normalize: true });
    const [n, dim] = out.dims;
    const flat = Array.from(out.data);
    const vs = [];
    for (let i = 0; i < n; i++) vs.push(flat.slice(i * dim, (i + 1) * dim));
    return { vs, dim };
  };
  await embed(['预热']); // warmup: keep ONNX session init out of the numbers
  const docEmbed = await embed(chunks.map((c) => c.content));
  const qEmbed = await embed(truth.map((t) => PREFIX + t.q));

  // per-text latency: 8 queries x 5 rounds, report median
  const times = [];
  for (let r = 0; r < 5; r++) {
    for (const t of truth) {
      const a = performance.now();
      await embed([PREFIX + t.q]);
      times.push(performance.now() - a);
    }
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];

  const ranks = truth.map((t, qi) => {
    const scores = chunks.map((c, ci) => ({ ci, s: dot(qEmbed.vs[qi], docEmbed.vs[ci]) }));
    scores.sort((a, b) => b.s - a.s);
    return scores.findIndex((x) => x.ci === t.idx) + 1;
  });
  const recall1 = ranks.filter((r) => r === 1).length / ranks.length;
  const recall3 = ranks.filter((r) => r <= 3).length / ranks.length;
  const mrr = ranks.reduce((s, r) => s + 1 / r, 0) / ranks.length;

  return {
    dtype,
    dim: docEmbed.dim,
    loadMs: Math.round(loadMs),
    chunkCount: chunks.length,
    perTextMsMedian: +median.toFixed(1),
    recall1: +recall1.toFixed(3),
    recall3: +recall3.toFixed(3),
    mrr: +mrr.toFixed(3),
    ranks,
  };
}

const dtypes = process.argv.slice(2);
if (!dtypes.length) dtypes.push('fp32', 'q8');
const results = [];
for (const d of dtypes) {
  console.log('=== running', d, '===');
  try {
    const r = await run(d);
    console.log(JSON.stringify(r));
    results.push(r);
  } catch (e) {
    console.error('FAILED', d, e.message);
    results.push({ dtype: d, error: String(e.message || e) });
  }
}
writeFileSync(resolve(outDir, 'quality.json'), JSON.stringify({ model: MODEL, corpus: 'demo-doc.md', queries: truth.map((t) => t.q), results }, null, 2));
console.log('written', resolve(outDir, 'quality.json'));
