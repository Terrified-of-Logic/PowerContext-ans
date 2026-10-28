/**
 * 后端：seekdb（嵌入式 / 远程实例）+ 端侧知识库检索接口
 *
 * 设计要点（对应赛题「seekdb 数据层」验收项）：
 * - 向量、原文与元数据全部存进 seekdb（VECTOR 列 + 普通列），不落到本地文件或内存索引；
 * - 向量 + 全文两路检索与 RRF 融合**在一条 SQL 内完成**（WITH ... UNION ALL 窗口函数），
 *   Node 侧只做参数替换与结果渲染，不分别取两路结果再自行拼合；
 * - 向量索引优先 HNSW，受限实例（Anon Mode）自动降级全表扫描；
 * - 全文索引优先 ngram 分词的 FULLTEXT 索引（中文可用），不支持时降级为 SQL 内 LIKE 计数；
 * - 写入采用「同 doc_id 先删后插」的增量替换，索引提交后新块立即可检索。
 *
 * seekdb 两种启动方式：
 * - 默认嵌入式：@oceanbase/seekdb-node 在本进程内拉起 seekdb，数据目录 ./data/seekdb.db
 * - 远程模式：SEEKDB_REMOTE=1 + SEEKDB_HOST/PORT/USER/PASSWORD/DB 连接已有实例
 */
import express from 'express';
import cors from 'cors';
import mysql from 'mysql2/promise';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { seekdb } from '@oceanbase/seekdb-node';

const PORT = process.env.PORT || 8787;
const DIM = 512;
const TABLE = 'kb_docs';
const RRF_K = 60;
const VEC_CANDIDATES = 50;
const KW_CANDIDATES = 200;

// seekdb.open() 不会自动创建父目录，必须先建好
const DATA_DIR = resolve(process.cwd(), process.env.DATA_DIR || 'data');
const DB_PATH = resolve(DATA_DIR, 'seekdb.db');

const app = express();
app.use(cors());
app.use(express.json({ limit: '32mb' }));

/* ---------------- 运行时状态 ---------------- */

let pool = null;
// seekdb 的运行时句柄必须长期持有，否则会被 GC 回收、子进程随之退出
let runtime = null;
const state = {
  engine: 'unknown', // seekdb 版本
  vectorIndex: 'unknown', // hnsw | full-scan
  keyword: 'unknown', // fulltext-ngram | fulltext | like
  hybrid: 'unknown', // single-sql | fallback-js
};

/* ---------------- 启动 seekdb 实例 ---------------- */

async function bootSeekdb() {
  // 远程实例模式（用于验证 / 或连接已有 seekdb 服务）
  if (process.env.SEEKDB_REMOTE === '1') {
    const p = (k, d) => process.env[k] || d;
    pool = mysql.createPool({
      host: p('SEEKDB_HOST', '127.0.0.1'),
      port: Number(p('SEEKDB_PORT', '2881')),
      user: p('SEEKDB_USER', 'root'),
      password: p('SEEKDB_PASSWORD', ''),
      database: p('SEEKDB_DB', 'test'),
      ssl: p('SEEKDB_SSL', '') === '1' ? {} : undefined,
      waitForConnections: true,
      connectionLimit: 4,
    });
    const [v] = await pool.query('SELECT VERSION() AS v');
    state.engine = v[0].v;
    console.log('[seekdb] 远程模式:', p('SEEKDB_HOST', ''), p('SEEKDB_PORT', ''), '| 版本:', state.engine);
    await initSchema();
    return null;
  }

  mkdirSync(DATA_DIR, { recursive: true });
  console.log('[seekdb] 启动嵌入式实例 …');
  console.log('[seekdb] 数据目录:', DATA_DIR);
  runtime = await seekdb.open(DB_PATH);
  const db = runtime;
  const opts = db.connectionOptions();
  console.log('[seekdb] endpoint:', JSON.stringify({ ...opts, password: undefined }));

  const location =
    opts.transport === 'tcp'
      ? { host: opts.host, port: opts.port }
      : opts.transport === 'unix_socket'
      ? { socketPath: opts.unixSocket }
      : { socketPath: opts.namedPipe };

  pool = mysql.createPool({
    ...location,
    user: opts.user,
    password: '',
    database: 'test',
    waitForConnections: true,
    connectionLimit: 4,
    supportBigNumbers: true,
  });

  const [v] = await pool.query('SELECT VERSION() AS v');
  state.engine = v[0].v;
  console.log('[seekdb] 版本:', state.engine);

  await initSchema();
  return db;
}

/* ---------------- 表结构 / 索引 ---------------- */

const createWithVectorIndex = `
  CREATE TABLE IF NOT EXISTS ${TABLE} (
    id        INT PRIMARY KEY AUTO_INCREMENT,
    doc_id    VARCHAR(255) NOT NULL,
    chunk_idx INT NOT NULL,
    title     VARCHAR(255) NOT NULL,
    content   TEXT NOT NULL,
    embedding VECTOR(${DIM}),
    VECTOR INDEX idx_vec (embedding) WITH (DISTANCE=l2, TYPE=hnsw, LIB=vsag),
    KEY idx_doc (doc_id)
  ) ORGANIZATION = HEAP`;

const createPlain = `
  CREATE TABLE IF NOT EXISTS ${TABLE} (
    id        INT PRIMARY KEY AUTO_INCREMENT,
    doc_id    VARCHAR(255) NOT NULL,
    chunk_idx INT NOT NULL,
    title     VARCHAR(255) NOT NULL,
    content   TEXT NOT NULL,
    embedding VECTOR(${DIM}),
    KEY idx_doc (doc_id)
  ) ORGANIZATION = HEAP`;

async function tableExists() {
  const [rows] = await pool.query(`SHOW TABLES LIKE '${TABLE}'`);
  return rows.length > 0;
}

async function initSchema() {
  const existed = await tableExists();
  if (!existed) {
    // 先试带 HNSW 向量索引的建表（一次 DDL 完成列 + 索引）
    try {
      await pool.query(createWithVectorIndex);
      state.vectorIndex = 'hnsw';
      console.log('[seekdb] 建表完成，向量索引 HNSW 已启用');
    } catch (e) {
      console.warn('[seekdb] HNSW 建表失败，降级全表扫描:', e.message);
      await pool.query(createPlain);
      state.vectorIndex = 'full-scan';
    }
  }

  const [create] = await pool.query(`SHOW CREATE TABLE ${TABLE}`);
  const createSql = create[0]['Create Table'] || '';
  if (existed) {
    // seekdb 的 SHOW CREATE TABLE 会把向量索引显示成 `VECTOR KEY idx_vec (...)`，
    // 全文索引显示成 `FULLTEXT KEY ...`，这里两种写法都认。
    state.vectorIndex = /VECTOR\s+(KEY|INDEX)/i.test(createSql) ? 'hnsw' : 'full-scan';
  }
  const hasFt = /FULLTEXT\s+(KEY|INDEX)/i.test(createSql);

  // 全文索引：优先 ngram（中文按 2-gram 分词），失败再试默认分词器，最后降级 LIKE
  if (!hasFt) {
    try {
      await pool.query(`ALTER TABLE ${TABLE} ADD FULLTEXT INDEX idx_ft (content, title) WITH PARSER ngram`);
      state.keyword = 'fulltext-ngram';
      console.log('[seekdb] 全文索引已启用（ngram 分词）');
    } catch (e1) {
      console.warn('[seekdb] ngram 全文索引不可用:', e1.message);
      try {
        await pool.query(`ALTER TABLE ${TABLE} ADD FULLTEXT INDEX idx_ft (content, title)`);
        state.keyword = 'fulltext';
        console.log('[seekdb] 全文索引已启用（默认分词器）');
      } catch (e2) {
        state.keyword = 'like';
        console.warn('[seekdb] 全文索引不可用，关键词路降级为 SQL LIKE:', e2.message);
      }
    }
  } else {
    state.keyword = /PARSER\s+ngram/i.test(createSql) ? 'fulltext-ngram' : 'fulltext';
  }
  state.hybrid = 'single-sql';
}

/* ---------------- 工具 ---------------- */

// mysql2 对 VECTOR 列接受字符串字面量：[0.1,0.2,...]
const vecLiteral = (arr) => '[' + arr.map((x) => Number(x).toFixed(6)).join(',') + ']';
const escapeLike = (s) => String(s).replace(/[\\%_]/g, (m) => '\\' + m);

/** 把查询拆成关键词项：空白分隔；中文长词补 2-gram，供 LIKE 降级路径使用。 */
function keywordTerms(query) {
  const raw = String(query || '').trim().split(/\s+/).filter(Boolean);
  const terms = [];
  for (const token of raw) {
    if (token.length <= 4) {
      terms.push(token);
      continue;
    }
    terms.push(token);
    for (let i = 0; i + 2 <= token.length && terms.length < 8; i += 1) {
      terms.push(token.slice(i, i + 2));
    }
  }
  return [...new Set(terms)].slice(0, 8);
}

/** 同一 doc_id 的旧块先删后插（增量替换），删除+插入在同一事务里。 */
async function ingestRecords(records) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const docIds = [...new Set(records.map((r) => String(r.doc_id).slice(0, 255)))];
    let replaced = 0;
    if (docIds.length) {
      const [del] = await conn.query(`DELETE FROM ${TABLE} WHERE doc_id IN (?)`, [docIds]);
      replaced = del.affectedRows;
    }
    const values = records.map((r) => [
      String(r.doc_id).slice(0, 255),
      Number(r.chunk_index) || 0,
      String(r.title || '').slice(0, 255),
      String(r.content || ''),
      vecLiteral(r.vector),
    ]);
    const [ret] = await conn.query(
      `INSERT INTO ${TABLE} (doc_id, chunk_idx, title, content, embedding) VALUES ?`,
      [values]
    );
    await conn.commit();
    return { inserted: ret.affectedRows, replaced, docs: docIds.length };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/** 单条 SQL 的混合检索：向量路 + 全文路在 SQL 内各自取排名，RRF 融合也在 SQL 内完成。 */
function buildHybridSql(query) {
  const match = `MATCH(content, title) AGAINST (? IN NATURAL LANGUAGE MODE)`;
  return {
    sql: `
WITH vec AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY l2_distance(embedding, ?)) AS rnk
  FROM ${TABLE}
  ORDER BY l2_distance(embedding, ?)
  LIMIT ${VEC_CANDIDATES}
),
kw AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY ${match} DESC) AS rnk
  FROM ${TABLE}
  WHERE ${match}
  LIMIT ${KW_CANDIDATES}
),
fused AS (
  SELECT id, SUM(1.0 / (${RRF_K} + rnk)) AS score
  FROM (SELECT id, rnk FROM vec UNION ALL SELECT id, rnk FROM kw) u
  GROUP BY id
)
SELECT d.id, d.doc_id, d.chunk_idx, d.title, d.content, f.score,
       l2_distance(d.embedding, ?) AS dist,
       ${match} AS ft_score
FROM fused f JOIN ${TABLE} d ON d.id = f.id
ORDER BY f.score DESC
LIMIT ?`,
    params: (vecLit, topk) => [vecLit, vecLit, query, query, vecLit, query, topk],
  };
}

function buildLikeHybridSql(terms) {
  const likeConds = terms.map(() => `(content LIKE ? ESCAPE '\\\\' OR title LIKE ? ESCAPE '\\\\')`).join(' OR ');
  const hitExpr = terms
    .map(
      () =>
        `(CASE WHEN content LIKE ? ESCAPE '\\\\' THEN 1 ELSE 0 END) + (CASE WHEN title LIKE ? ESCAPE '\\\\' THEN 1 ELSE 0 END)`
    )
    .join(' + ');
  return {
    sql: `
WITH vec AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY l2_distance(embedding, ?)) AS rnk
  FROM ${TABLE}
  ORDER BY l2_distance(embedding, ?)
  LIMIT ${VEC_CANDIDATES}
),
kw AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY hit DESC) AS rnk
  FROM (SELECT id, (${hitExpr}) AS hit
        FROM ${TABLE}
        WHERE ${likeConds}
        ORDER BY hit DESC
        LIMIT ${KW_CANDIDATES}) x
),
fused AS (
  SELECT id, SUM(1.0 / (${RRF_K} + rnk)) AS score
  FROM (SELECT id, rnk FROM vec UNION ALL SELECT id, rnk FROM kw) u
  GROUP BY id
)
SELECT d.id, d.doc_id, d.chunk_idx, d.title, d.content, f.score,
       l2_distance(d.embedding, ?) AS dist,
       (${hitExpr}) AS ft_score
FROM fused f JOIN ${TABLE} d ON d.id = f.id
ORDER BY f.score DESC
LIMIT ?`,
    params: (vecLit, _query, topk) => {
      const likeParams = terms.flatMap((t) => {
        const p = `%${escapeLike(t)}%`;
        return [p, p];
      });
      return [vecLit, vecLit, ...likeParams, ...likeParams, vecLit, ...likeParams, topk];
    },
  };
}

/** 最后兜底：两路 SQL 分开取 + Node 侧 RRF（仅在单条 SQL 报错时使用，并在响应里标注）。 */
async function fallbackSearch(vecLit, query, topk) {
  const [vecRows] = await pool.query(
    `SELECT id, l2_distance(embedding, ?) AS dist FROM ${TABLE} ORDER BY dist ASC LIMIT ${VEC_CANDIDATES}`,
    [vecLit]
  );
  const terms = keywordTerms(query);
  let kwRows = [];
  if (terms.length) {
    const cond = terms.map(() => `(content LIKE ? ESCAPE '\\\\' OR title LIKE ? ESCAPE '\\\\')`).join(' OR ');
    const params = terms.flatMap((t) => {
      const p = `%${escapeLike(t)}%`;
      return [p, p];
    });
    const [rows] = await pool.query(`SELECT id FROM ${TABLE} WHERE ${cond} LIMIT ${KW_CANDIDATES}`, params);
    kwRows = rows;
  }
  const scores = new Map();
  vecRows.forEach((r, i) => scores.set(r.id, (scores.get(r.id) || 0) + 1 / (RRF_K + i + 1)));
  kwRows.forEach((r, i) => scores.set(r.id, (scores.get(r.id) || 0) + 1 / (RRF_K + i + 1)));
  const top = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, topk);
  if (!top.length) return [];
  const ids = top.map(([id]) => id);
  const [detail] = await pool.query(
    `SELECT id, doc_id, chunk_idx, title, content, l2_distance(embedding, ?) AS dist FROM ${TABLE} WHERE id IN (?)`,
    [vecLit, ids]
  );
  const byId = new Map(detail.map((d) => [d.id, d]));
  return top
    .map(([id, score]) => {
      const d = byId.get(id);
      return d ? { ...d, score } : null;
    })
    .filter(Boolean);
}

/* ---------------- HTTP 接口 ---------------- */

app.get('/api/health', async (_req, res) => {
  try {
    const [c] = await pool.query(`SELECT COUNT(*) AS n FROM ${TABLE}`);
    res.json({ ok: true, version: state.engine, docs: c[0].n, ...state });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** 知识库当前状态：块数、文件列表（会话状态在 seekdb 中持久化，重启后仍可读回）。 */
app.get('/api/stats', async (_req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT doc_id, COUNT(*) AS chunks FROM ${TABLE} GROUP BY doc_id ORDER BY doc_id`
    );
    res.json({
      ok: true,
      docs: rows.reduce((n, r) => n + Number(r.chunks), 0),
      files: rows.map((r) => ({ docId: r.doc_id, chunks: Number(r.chunks) })),
      ...state,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/ingest', async (req, res) => {
  const { records } = req.body || {};
  if (!Array.isArray(records) || !records.length) {
    return res.status(400).json({ error: 'records 为空' });
  }
  for (const r of records) {
    if (!Array.isArray(r.vector) || r.vector.length !== DIM) {
      return res.status(400).json({ error: `向量维度必须是 ${DIM}` });
    }
  }
  try {
    const started = Date.now();
    const result = await ingestRecords(records);
    // 写入提交后立刻读一次，确认新块对同一实例可见（索引刷新语义验证）
    const [visible] = await pool.query(
      `SELECT COUNT(*) AS n FROM ${TABLE} WHERE doc_id = ?`,
      [String(records[0].doc_id).slice(0, 255)]
    );
    res.json({ ...result, visibleChunks: visible[0].n, writeMs: Date.now() - started, ...state });
  } catch (e) {
    console.error('[ingest]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/search', async (req, res) => {
  const { query = '', vector, topk = 8 } = req.body || {};
  if (!Array.isArray(vector) || vector.length !== DIM) {
    return res.status(400).json({ error: `vector 必须是 ${DIM} 维数组` });
  }
  const q = String(query || '').trim();
  const terms = keywordTerms(q);
  if (!q || !terms.length) return res.status(400).json({ error: 'query 不能为空' });

  const vecLit = vecLiteral(vector);
  const limit = Math.max(1, Math.min(50, Number(topk) || 8));
  const started = Date.now();
  let hits = null;
  let hybrid = 'single-sql';
  let keywordMode = state.keyword;
  try {
    if (state.keyword === 'like') {
      const built = buildLikeHybridSql(terms);
      const [rows] = await pool.query(built.sql, built.params(vecLit, q, limit));
      hits = rows;
    } else {
      const built = buildHybridSql(q);
      const [rows] = await pool.query(built.sql, built.params(vecLit, limit));
      hits = rows;
    }
  } catch (e) {
    console.warn('[search] 单条 SQL 混合检索失败，切兜底路径:', e.message);
    hybrid = 'fallback-js';
    keywordMode = 'like';
    hits = await fallbackSearch(vecLit, q, limit);
  }

  const searchMs = Date.now() - started;
  res.json({
    hits: (hits || []).map((h) => ({
      id: h.id,
      title: h.title,
      content: h.content,
      doc_id: h.doc_id,
      chunk_idx: h.chunk_idx,
      dist: h.dist === undefined ? null : Number(h.dist),
      kw_hits: h.ft_score === undefined ? null : Number(h.ft_score),
      score: Number(h.score),
    })),
    searchMs,
    hybrid,
    keywordMode,
    ...state,
  });
});

/* ---------------- 启动 ---------------- */

bootSeekdb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(
        `[server] http://127.0.0.1:${PORT}  向量索引=${state.vectorIndex} 关键词=${state.keyword} 混合=${state.hybrid}`
      );
    });
  })
  .catch((e) => {
    console.error('[fatal] seekdb 启动失败：', e);
    process.exit(1);
  });
