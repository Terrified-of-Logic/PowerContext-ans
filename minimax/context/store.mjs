/**
 * seekdb 存储层：工程资料（规格 / 代码 / 测试）的存取
 *
 * 使用嵌入式 seekdb（进程内启动，数据落在 ./data/seekdb.db）
 */
import mysql from 'mysql2/promise';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const TABLE = 'ctx_docs';
const DIM = 512;

let pool = null;
let runtime = null;   // 必须长期持有，否则 GC 后子进程退出
let indexMode = 'unknown';

export async function open(dataDir = './data') {
  if (pool) return { pool, indexMode };

  // 远程模式：连接已有的 seekdb / OceanBase 服务（评委也可用这种）
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
    await pool.query('SELECT 1');
    await initSchema();
    return { pool, indexMode };
  }

  // 嵌入式模式（默认）
  const { seekdb } = await import('@oceanbase/seekdb-node');
  const dir = resolve(process.cwd(), dataDir);
  mkdirSync(dir, { recursive: true });

  runtime = await seekdb.open(resolve(dir, 'seekdb.db'));
  const opts = runtime.connectionOptions();

  const location =
    opts.transport === 'tcp'
      ? { host: opts.host, port: opts.port }
      : { socketPath: opts.unixSocket || opts.namedPipe };

  pool = mysql.createPool({
    ...location,
    user: opts.user,
    password: '',
    database: 'test',
    waitForConnections: true,
    connectionLimit: 4,
  });

  await initSchema();
  return { pool, indexMode };
}

async function initSchema() {
  const plain = `
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id        INT PRIMARY KEY AUTO_INCREMENT,
      path      VARCHAR(255) NOT NULL,
      kind      VARCHAR(20)  NOT NULL,
      heading   VARCHAR(255) NOT NULL DEFAULT '',
      symbol    VARCHAR(255) NOT NULL DEFAULT '',
      content   TEXT NOT NULL,
      KEY idx_kind (kind)
    ) ORGANIZATION = HEAP`;

  await pool.query(plain);
  indexMode = 'full-scan';
}

/** 清空并重建（ingest 前调用，保证重新导入后内容是最新的） */
export async function reset() {
  await pool.query(`TRUNCATE TABLE ${TABLE}`);
}

/** 批量写入 */
export async function insertAll(rows) {
  if (!rows.length) return 0;
  const values = rows.map((r) => [
    String(r.path).slice(0, 255),
    String(r.kind).slice(0, 20),
    String(r.heading || '').slice(0, 255),
    String(r.symbol || '').slice(0, 255),
    String(r.content || ''),
  ]);
  const [ret] = await pool.query(
    `INSERT INTO ${TABLE} (path, kind, heading, symbol, content) VALUES ?`,
    [values]
  );
  return ret.affectedRows;
}

/** 取全部（语料规模小，检索在 Node 侧打分） */
export async function fetchAll() {
  const [rows] = await pool.query(
    `SELECT id, path, kind, heading, symbol, content FROM ${TABLE} ORDER BY id`
  );
  return rows;
}

export async function count() {
  const [r] = await pool.query(`SELECT COUNT(*) AS n FROM ${TABLE}`);
  return r[0].n;
}

export async function close() {
  if (pool) { await pool.end(); pool = null; }
}
