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
  // 向量索引 + 中文全文索引。混合检索必须由 seekdb 完成（题目 2.3 要求），
  // 所以全文索引是必需的，不能退化成客户端拼合。
  const withHnsw = (parser) => `
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id        INT PRIMARY KEY AUTO_INCREMENT,
      doc_id    VARCHAR(255) NOT NULL,
      chunk_idx INT NOT NULL,
      title     VARCHAR(255) NOT NULL,
      content   TEXT NOT NULL,
      embedding VECTOR(${DIM}),
      VECTOR INDEX idx_vec (embedding) WITH (DISTANCE=l2, TYPE=hnsw, LIB=vsag),
      FULLTEXT INDEX idx_ft (content) WITH PARSER ${parser},
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

  // 依次尝试：ik 分词 → ngram 分词 → 无全文索引
  for (const parser of ['ik', 'ngram']) {
    try {
      await pool.query(withHnsw(parser));
      mode = `hnsw+fts(${parser})`;
      console.log(`[seekdb] 建表完成：HNSW 向量索引 + 全文索引（parser=${parser}）`);
      return;
    } catch (e) {
      console.log(`[seekdb] parser=${parser} 不可用：${String(e.message).slice(0, 80)}`);
    }
  }

  // 退化：先试带向量索引但不带全文索引
  try {
    await pool.query(withHnsw.replace(/\s*FULLTEXT INDEX idx_ft \(content\) WITH PARSER \$\{parser\},/, ''));
    mode = 'hnsw';
    console.log('[seekdb] 建表完成：仅 HNSW 向量索引（无全文索引）');
    return;
  } catch { /* ignore */ }

  await pool.query(plain);
  mode = 'full-scan';
  console.log('[seekdb] 当前实例限制较多，降级为全表扫描');
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
    // 增量导入：同一文件的旧分块先删掉再写入，避免重复堆积，
    // 新增文件不影响已有内容（验收要求「支持增量导入、索引刷新后新增内容可检索」）
    const docIds = [...new Set(records.map((r) => String(r.doc_id)))];
    if (docIds.length) {
      const [del] = await pool.query(
        `DELETE FROM ${TABLE} WHERE doc_id IN (?)`,
        [docIds]
      );
      if (del.affectedRows) console.log(`[ingest] 覆盖旧分块 ${del.affectedRows} 条`);
    }

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

  const k = Math.max(1, Math.min(50, Number(topk) || 8));

  try {
    const lit = vecLiteral(vector);
    const q = String(query || '').trim();
    const hasFts = mode.includes('fts');

    // 混合检索由 seekdb 一条 SQL 完成（题目 2.3 要求）：
    //   全文得分 MATCH ... AGAINST  +  向量距离 l2_distance
    //   两路排名用窗口函数在 SQL 内做 RRF 融合，服务端不再分别取两路再拼合
    const sql = hasFts
      ? `SELECT id, doc_id, chunk_idx, title, content, ft_score, vec_dist,
                (1.0 / (60 + r_vec)) + (1.0 / (60 + r_ft)) AS score
           FROM (
             SELECT b.*,
                    ROW_NUMBER() OVER (ORDER BY vec_dist ASC)  AS r_vec,
                    ROW_NUMBER() OVER (ORDER BY ft_score DESC) AS r_ft
               FROM (
                 SELECT id, doc_id, chunk_idx, title, content,
                        MATCH(content) AGAINST(? IN NATURAL LANGUAGE MODE) AS ft_score,
                        l2_distance(embedding, ?) AS vec_dist
                   FROM ${TABLE}
               ) b
           ) t
          ORDER BY score DESC
          LIMIT ${k}`
      : `SELECT id, doc_id, chunk_idx, title, content, 0 AS ft_score, vec_dist,
                (1.0 / (60 + r_vec)) AS score
           FROM (
             SELECT b.*, ROW_NUMBER() OVER (ORDER BY vec_dist ASC) AS r_vec
               FROM (
                 SELECT id, doc_id, chunk_idx, title, content,
                        l2_distance(embedding, ?) AS vec_dist
                   FROM ${TABLE}
               ) b
           ) t
          ORDER BY score DESC
          LIMIT ${k}`;

    const params = hasFts ? [q, lit] : [lit];
    const [rows] = await pool.query(sql, params);

    const hits = rows.map((r) => ({
      id: r.id,
      title: r.title,
      content: r.content,
      doc_id: r.doc_id,
      chunk_idx: r.chunk_idx,
      dist: Number(r.vec_dist),
      ft_score: Number(r.ft_score),
      kw_hits: Number(r.ft_score) > 0 ? 1 : 0,
      score: Number(r.score),
    }));

    res.json({ hits, indexMode: mode, fusion: 'rrf-in-sql' });
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
