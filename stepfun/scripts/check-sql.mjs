// seekdb SQL 兼容性自检：验证应用依赖的 DDL / 单条 SQL 混合检索在当前 seekdb 上可用。
//
// 用法（先启动 seekdb，嵌入式模式见 README；或连已有实例）：
//   SEEKDB_HOST=127.0.0.1 SEEKDB_PORT=2882 SEEKDB_USER=root SEEKDB_PASSWORD= node scripts/check-sql.mjs
//
// 输出每条用例 PASS/FAIL，最后汇总；任一 FAIL 时退出码非 0。
import mysql from 'mysql2/promise';

const host = process.env.SEEKDB_HOST || '127.0.0.1';
const port = Number(process.env.SEEKDB_PORT || '2882');
const user = process.env.SEEKDB_USER || 'root';
const password = process.env.SEEKDB_PASSWORD || '';
const database = process.env.SEEKDB_DB || 'test';
const DIM = 512;
const T = 'kb_docs_sqlcheck';

const pool = mysql.createPool({ host, port, user, password, database, waitForConnections: true, connectionLimit: 2 });
const lit = (arr) => '[' + arr.map((x) => Number(x).toFixed(6)).join(',') + ']';
const pseudo = (seed) => Array.from({ length: DIM }, (_, i) => Math.sin(seed * 1.7 + i * 0.13));
let pass = 0;
let fail = 0;
const step = async (name, fn) => {
  try {
    const r = await fn();
    pass += 1;
    console.log('PASS', name, r === undefined ? '' : JSON.stringify(r).slice(0, 180));
    return r;
  } catch (e) {
    fail += 1;
    console.log('FAIL', name, '|', e.code || '', e.message);
    return null;
  }
};

const match = `MATCH(content, title) AGAINST (? IN NATURAL LANGUAGE MODE)`;
const hybridSql = `
WITH vec AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY l2_distance(embedding, ?)) AS rnk
  FROM ${T} ORDER BY l2_distance(embedding, ?) LIMIT 50
),
kw AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY ${match} DESC) AS rnk
  FROM ${T} WHERE ${match} LIMIT 200
),
fused AS (
  SELECT id, SUM(1.0 / (60 + rnk)) AS score
  FROM (SELECT id, rnk FROM vec UNION ALL SELECT id, rnk FROM kw) u GROUP BY id
)
SELECT d.id, d.title, d.content, f.score, l2_distance(d.embedding, ?) AS dist, ${match} AS ft_score
FROM fused f JOIN ${T} d ON d.id = f.id ORDER BY f.score DESC LIMIT ?`;

const main = async () => {
  await step('连接 + 版本', async () => (await pool.query('SELECT VERSION() AS v'))[0][0].v);
  await step('清理旧表', () => pool.query(`DROP TABLE IF EXISTS ${T}`));
  await step('建表（VECTOR 列 + HNSW 向量索引）', () =>
    pool.query(`CREATE TABLE ${T} (
      id INT PRIMARY KEY AUTO_INCREMENT,
      doc_id VARCHAR(255) NOT NULL,
      chunk_idx INT NOT NULL,
      title VARCHAR(255) NOT NULL,
      content TEXT NOT NULL,
      embedding VECTOR(${DIM}),
      VECTOR INDEX idx_vec (embedding) WITH (DISTANCE=l2, TYPE=hnsw, LIB=vsag),
      KEY idx_doc (doc_id)
    ) ORGANIZATION = HEAP`)
  );
  await step('建全文索引（ngram 分词）', () =>
    pool.query(`ALTER TABLE ${T} ADD FULLTEXT INDEX idx_ft (content, title) WITH PARSER ngram`)
  );
  await step('写入 VECTOR 字面量参数', () =>
    pool.query(`INSERT INTO ${T} (doc_id, chunk_idx, title, content, embedding) VALUES ?`, [
      [
        ['demo.md', 0, '向量索引', '向量索引怎么建 HNSW 索引', lit(pseudo(1))],
        ['demo.md', 1, '混合检索', '混合检索与 RRF 融合', lit(pseudo(2))],
        ['demo.md', 2, '端侧推理', '端侧推理 WebGPU 与 WASM', lit(pseudo(3))],
      ],
    ])
  );
  await step('提交后立即可见（索引刷新语义）', async () => {
    const [r] = await pool.query(`SELECT COUNT(*) AS n FROM ${T}`);
    return r[0].n;
  });
  await step('单条 SQL 混合检索（向量路 + 全文路 + RRF 融合）', async () => {
    const [r] = await pool.query(hybridSql, [lit(pseudo(1)), lit(pseudo(1)), '向量索引', '向量索引', lit(pseudo(1)), '向量索引', 5]);
    if (!r.length) throw new Error('no hits');
    return r.map((x) => ({ title: x.title, score: +Number(x.score).toFixed(5), ft: +Number(x.ft_score).toFixed(3) }));
  });
  await step('同 doc_id 增量替换（先删后插）', async () => {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(`DELETE FROM ${T} WHERE doc_id = ?`, ['demo.md']);
      await conn.query(`INSERT INTO ${T} (doc_id, chunk_idx, title, content, embedding) VALUES (?,?,?,?,?)`, [
        'demo.md', 0, '新版', '增量替换后的新内容', lit(pseudo(4)),
      ]);
      await conn.commit();
    } finally {
      conn.release();
    }
    const [r] = await pool.query(`SELECT COUNT(*) AS n FROM ${T} WHERE doc_id = 'demo.md'`);
    if (r[0].n !== 1) throw new Error('replaced chunks = ' + r[0].n);
    return r[0].n;
  });
  await step('清理', () => pool.query(`DROP TABLE IF EXISTS ${T}`));
  await pool.end();
  console.log(`\nSUMMARY pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
};

main().catch(async (e) => {
  console.error('FATAL', e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
