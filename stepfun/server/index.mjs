/**
 * 后端：seekdb 嵌入式实例 + 混合检索接口
 *
 * - seekdb 以嵌入式方式在本进程内启动（@oceanbase/seekdb-node，自带平台原生包）
 * - 数据落在 ./data/seekdb.db
 * - 向量列 VECTOR(512)，距离函数 l2_distance / cosine_distance
 * - 向量索引：尝试建 HNSW，受限环境（Anon Mode）建不了就降级为全表扫描
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

// seekdb.open() 不会自动创建父目录，必须先建好
const DATA_DIR = resolve(process.cwd(), process.env.DATA_DIR || 'data');
const DB_PATH = resolve(DATA_DIR, 'seekdb.db');

const app = express();
app.use(cors());
app.use(express.json({ limit: '32mb' }));

/* ---------------- 启动 seekdb 嵌入式实例 ---------------- */

let pool = null;
let mode = 'unknown';
// seekdb 的运行时句柄必须长期持有，否则会被 GC 回收、子进程随之退出
let runtime = null;

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
    console.log('[seekdb] 远程模式:', p('SEEKDB_HOST', ''), p('SEEKDB_PORT', ''), '| 版本:', v[0].v);
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

  // 探活
  const [v] = await pool.query('SELECT VERSION() AS v');
  console.log('[seekdb] 版本:', v[0].v);

  await initSchema();
  return db;
}

async function initSchema() {
  // 先试带向量索引的建表（HNSW）；受限环境会报 Anon Mode，自动降级
  const withIndex = `
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

  const plain = `
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id        INT PRIMARY KEY AUTO_INCREMENT,
      doc_id    VARCHAR(255) NOT NULL,
      chunk_idx INT NOT NULL,
      title     VARCHAR(255) NOT NULL,
      content   TEXT NOT NULL,
      embedding VECTOR(${DIM}),
      KEY idx_doc (doc_id)
    ) ORGANIZATION = HEAP`;

  try {
    await pool.query(withIndex);
    mode = 'hnsw';
    console.log('[seekdb] 建表完成，向量索引 HNSW 已启用');
  } catch (e) {
    if (/Anon Mode|not supported/i.test(e.message)) {
      await pool.query(plain);
      mode = 'full-scan';
      console.log('[seekdb] 当前实例不允许建向量索引，降级为全表扫描（数据量小可接受）');
    } else {
      throw e;
    }
  }
}

/* ---------------- 工具 ---------------- */

// mysql2 对 VECTOR 列接受字符串字面量：[0.1,0.2,...]
const vecLiteral = (arr) => '[' + arr.map((x) => Number(x).toFixed(6)).join(',') + ']';

const escapeLike = (s) => s.replace(/[\\%_]/g, (m) => '\\' + m);

function rrfFuse(rankLists, k = 60) {
  const scores = new Map();
  for (const list of rankLists) {
    list.forEach((id, rank) => {
      scores.set(id, (scores.get(id) || 0) + 1 / (k + rank + 1));
    });
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]);
}

/* ---------------- 接口 ---------------- */

app.get('/api/health', async (_req, res) => {
  try {
    const [v] = await pool.query('SELECT VERSION() AS v');
    const [c] = await pool.query(`SELECT COUNT(*) AS n FROM ${TABLE}`);
    res.json({ ok: true, version: v[0].v, docs: c[0].n, indexMode: mode });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/ingest', async (req, res) => {
  const { records } = req.body || {};
  if (!Array.isArray(records) || !records.length) {
    return res.status(400).json({ error: 'records 为空' });
  }
  if (records[0].vector?.length !== DIM) {
    return res.status(400).json({ error: `向量维度必须是 ${DIM}` });
  }

  try {
    const values = records.map((r) => [
      String(r.doc_id).slice(0, 255),
      Number(r.chunk_index) || 0,
      String(r.title || '').slice(0, 255),
      String(r.content || ''),
      vecLiteral(r.vector),
    ]);

    const [ret] = await pool.query(
      `INSERT INTO ${TABLE} (doc_id, chunk_idx, title, content, embedding) VALUES ?`,
      [values]
    );
    res.json({ inserted: ret.affectedRows });
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

  try {
    const lit = vecLiteral(vector);

    // 路 1：向量距离（seekdb 的 l2_distance 在 SQL 里算）
    const [vecRows] = await pool.query(
      `SELECT id, l2_distance(embedding, ?) AS dist
         FROM ${TABLE}
        ORDER BY dist ASC
        LIMIT 50`,
      [lit]
    );

    // 路 2：关键词命中次数
    const terms = String(query).split(/\s+/).filter(Boolean).slice(0, 6);
    let kwRows = [];
    if (terms.length) {
      const cond = terms
        .map(() => `(content LIKE ? ESCAPE '\\\\' OR title LIKE ? ESCAPE '\\\\')`)
        .join(' OR ');
      const params = [];
      for (const t of terms) {
        const p = `%${escapeLike(t)}%`;
        params.push(p, p);
      }
      const [rows] = await pool.query(
        `SELECT id, content, title FROM ${TABLE} WHERE ${cond} LIMIT 200`,
        params
      );
      kwRows = rows;
    }

    // 混合：RRF 融合两路排名
    const vecRank = vecRows.map((r) => r.id);
    const kwRank = kwRows.map((r) => r.id);
    const fused = rrfFuse([vecRank, kwRank].filter((l) => l.length));

    const top = fused.slice(0, topk);
    if (!top.length) return res.json({ hits: [] });

    const ids = top.map(([id]) => id);
    const [detail] = await pool.query(
      `SELECT id, doc_id, chunk_idx, title, content FROM ${TABLE} WHERE id IN (?)`,
      [ids]
    );
    const byId = new Map(detail.map((d) => [d.id, d]));

    const distById = new Map(vecRows.map((r) => [r.id, Number(r.dist)]));
    const kwCount = new Map();
    for (const r of kwRows) {
      const text = `${r.title}\n${r.content}`.toLowerCase();
      kwCount.set(r.id, terms.reduce((n, t) => n + (text.split(t.toLowerCase()).length - 1), 0));
    }

    const hits = top
      .map(([id, score]) => {
        const d = byId.get(id);
        if (!d) return null;
        return {
          id,
          title: d.title,
          content: d.content,
          doc_id: d.doc_id,
          chunk_idx: d.chunk_idx,
          dist: distById.get(id) ?? 999,
          kw_hits: kwCount.get(id) ?? 0,
          score,
        };
      })
      .filter(Boolean);

    res.json({ hits, indexMode: mode, candidates: { vec: vecRank.length, kw: kwRank.length } });
  } catch (e) {
    console.error('[search]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ---------------- 启动 ---------------- */

bootSeekdb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`[server] http://127.0.0.1:${PORT}  索引模式=${mode}`);
    });
  })
  .catch((e) => {
    console.error('[fatal] seekdb 启动失败：', e);
    process.exit(1);
  });
