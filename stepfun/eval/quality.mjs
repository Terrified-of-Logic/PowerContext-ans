/**
 * 检索质量评测：Recall@K / MRR / nDCG@K
 *
 * 用与提交应用相同的实现（相同切分、相同模型、相同 CLS 池化）跑评测集，
 * 结果写入 eval/quality-report.json。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { pipeline, env } from '@huggingface/transformers';

env.allowLocalModels = false;
env.useBrowserCache = false;
env.remoteHost = 'https://modelscope.cn/models';
env.remotePathTemplate = '{model}/resolve/master/';

const MODEL = 'onnx-community/bge-small-zh-v1.5-ONNX';
const PREFIX = '为这个句子生成表示以用于检索相关文章：';

/* ---------- 与 src/main.js 完全一致的分块 ---------- */
function chunkText(text, { max = 400, min = 40 } = {}) {
  const clean = text.replace(/\r\n/g, '\n')
    .replace(/(#{1,6}\s[^\n]*)\n/g, '$1\n\n')
    .replace(/\n(#{1,6}\s)/g, '\n\n$1')
    .replace(/\n{3,}/g, '\n\n').trim();
  const paras = clean.split(/\n{2,}/);
  const chunks = [];
  for (const p0 of paras) {
    const p = p0.trim();
    if (!p) continue;
    if (/^#{1,6}\s/.test(p) && p.length < 20) continue;
    if (p.length <= max) { chunks.push(p); continue; }
    const sents = p.match(/[^。！？!?；;\n]+[。！？!?；;]?/g) || [p];
    let buf = '';
    for (const s of sents) {
      if ((buf + s).length <= max) buf += s;
      else { if (buf.trim()) chunks.push(buf.trim()); buf = s.length > max ? s.slice(0, max) : s; }
    }
    if (buf.trim()) chunks.push(buf.trim());
  }
  return chunks.filter((c) => c.length >= min);
}

/* ---------- 评测集：查询 → 可接受的答案片段（任一命中即算相关） ---------- */
const EVAL = [
  { q: '向量索引怎么建', must: ['VECTOR 列', 'VECTOR INDEX'] },
  { q: 'RRF 是什么', must: ['Reciprocal Rank Fusion', 'RRF 的好处'] },
  { q: '为什么要把推理放进 Worker', must: ['Web Worker'] },
  { q: '混合检索有什么好处', must: ['混合检索把两路结果融合'] },
  { q: '量化到 8 位有什么好处', must: ['8 位整数'] },
  { q: '端侧推理有什么好处', must: ['数据不出本地', '端侧推理指模型在用户设备上运行'] },
  { q: 'l2 和 cosine 距离怎么用', must: ['l2_distance'] },
  { q: '嵌入式模式有什么价值', must: ['嵌入式模式的价值'] },
];

const matches = (text, must) => (Array.isArray(must) ? must : [must]).some((m) => text.includes(m));

const chunks = chunkText(readFileSync('demo-doc.md', 'utf8'));
console.log(`语料：${chunks.length} 个块`);

const ex = await pipeline('feature-extraction', MODEL, { dtype: 'q8' });
await ex(['预热'], { pooling: 'cls', normalize: true });

async function emb(texts) {
  const out = await ex(texts, { pooling: 'cls', normalize: true });
  const [n, dim] = out.dims;
  const flat = Array.from(out.data);
  const v = [];
  for (let i = 0; i < n; i++) v.push(flat.slice(i * dim, (i + 1) * dim));
  return v;
}

const t0 = Date.now();
const docVecs = await emb(chunks);
const docMs = Date.now() - t0;
console.log(`文档向量化：${chunks.length} 块 ${docMs}ms  →  ${(chunks.length / (docMs / 1000)).toFixed(1)} 块/秒`);

const cos = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

let hit1 = 0, hit3 = 0, hit5 = 0, mrrSum = 0, ndcgSum = 0;
const details = [];
const tQuery = [];

for (const { q, must } of EVAL) {
  const ts = Date.now();
  const [qv] = await emb([PREFIX + q]);
  tQuery.push(Date.now() - ts);

  const ranked = docVecs
    .map((dv, i) => ({ i, score: cos(dv, qv) }))
    .sort((a, b) => b.score - a.score);

  const rank = ranked.findIndex((r) => matches(chunks[r.i], must)) + 1;
  const hit = rank > 0;

  if (rank === 1) hit1++;
  if (rank >= 1 && rank <= 3) hit3++;
  if (rank >= 1 && rank <= 5) hit5++;
  if (hit) { mrrSum += 1 / rank; ndcgSum += 1 / Math.log2(rank + 1); }

  details.push({
    query: q,
    expect: must,
    rank: rank || null,
    hit,
    top1: chunks[ranked[0].i].replace(/\s+/g, ' ').slice(0, 40),
  });
  console.log(`  ${hit ? 'OK  ' : 'MISS'} rank=${rank || '-'}  「${q}」`);
}

const n = EVAL.length;
const median = (arr) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

const report = {
  model: MODEL,
  quantization: 'INT8 (q8)',
  pooling: 'cls',
  corpus_chunks: chunks.length,
  queries: n,
  metrics: {
    recall_at_1: +(hit1 / n).toFixed(4),
    recall_at_3: +(hit3 / n).toFixed(4),
    recall_at_5: +(hit5 / n).toFixed(4),
    mrr: +(mrrSum / n).toFixed(4),
    ndcg_at_5: +(ndcgSum / n).toFixed(4),
  },
  timing: {
    doc_embed_ms_total: docMs,
    doc_embed_ms_per_chunk: +(docMs / chunks.length).toFixed(1),
    doc_embed_chunks_per_sec: +(chunks.length / (docMs / 1000)).toFixed(1),
    query_embed_ms_median: median(tQuery),
  },
  details,
};

mkdirSync('eval', { recursive: true });
writeFileSync('eval/quality-report.json', JSON.stringify(report, null, 2), 'utf8');

console.log('\n=== 结果 ===');
console.log(JSON.stringify(report.metrics, null, 2));
console.log('查询向量化中位数:', report.timing.query_embed_ms_median, 'ms');
console.log('已写入 eval/quality-report.json');
