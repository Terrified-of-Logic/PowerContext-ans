#!/usr/bin/env node
/**
 * 上下文模块 CLI —— 题目要求的「明确调用入口」
 *
 *   node context/cli.mjs ingest
 *       扫描业务工程，把规格 / 代码 / 测试写入 seekdb
 *
 *   node context/cli.mjs context --task "实现按状态过滤" [--json|-j] [--out 文件] [--no-pc]
 *       按任务检索并组装开发上下文
 *
 *   node context/cli.mjs status --set "文本"     保存一条任务状态到 PowerContext
 *   node context/cli.mjs status --list           读回全部状态（重启后复用）
 *   node context/cli.mjs stats                   看库里有多少条目
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { collect } from './ingest.mjs';
import { buildContext, renderMarkdown } from './retrieve.mjs';
import * as pc from './powercontext.mjs';

const BUSINESS = process.env.BUSINESS_DIR || resolve(process.cwd(), 'business');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) { out[key] = next; i++; }
      else out[key] = true;
    } else if (a.startsWith('-') && a.length === 2) {
      out[a.slice(1)] = true;
    } else out._.push(a);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];

async function withStore(fn) {
  const { open, close } = await import('./store.mjs');
  try {
    await open(process.env.SEEKDATA || './data');
    return await fn(await import('./store.mjs'));
  } finally {
    await close();
  }
}

if (cmd === 'ingest') {
  const rows = collect(BUSINESS);
  const byKind = rows.reduce((m, r) => (m[r.kind] = (m[r.kind] || 0) + 1, m), {});
  console.log(`扫描 ${BUSINESS}`);
  console.log(`切分出 ${rows.length} 条：`, JSON.stringify(byKind));
  for (const r of rows) console.log(`  [${r.kind}] ${r.path} ${r.heading || r.symbol || ''}`);

  await withStore(async (db) => {
    await db.reset();
    const n = await db.insertAll(rows);
    console.log(`\n写入 seekdb：${n} 条`);
    console.log(`库内总条目：${await db.count()}`);
  });
  process.exit(0);
}

if (cmd === 'stats') {
  await withStore(async (db) => {
    console.log('库内条目数：', await db.count());
    const all = await db.fetchAll();
    const byKind = all.reduce((m, r) => (m[r.kind] = (m[r.kind] || 0) + 1, m), {});
    console.log('按类型：', JSON.stringify(byKind));
  });
  process.exit(0);
}

if (cmd === 'context') {
  const task = args.task || args.t;
  if (!task) { console.error('缺少 --task "任务描述"'); process.exit(1); }

  await withStore(async (db) => {
    const rows = await db.fetchAll();
    if (!rows.length) {
      console.error('库里没有资料，先运行：node context/cli.mjs ingest');
      process.exit(1);
    }
    const ctx = buildContext(rows, task);

    // 追加 PowerContext 里的任务状态（任务进展 / 待办 / 已验证）
    let status = null;
    if (!args['no-pc']) {
      try {
        const entries = await pc.listAll(50);
        status = { ...pc.summarize(entries), entries };
      } catch (e) {
        status = { error: `PowerContext 不可用：${e.message}`, done: [], todo: [], verified: [] };
      }
    }
    ctx.status = status;

    const mode = args.json || args.j ? 'json' : 'md';
    const text = mode === 'json' ? JSON.stringify(ctx, null, 2) : renderMarkdown(ctx)
      + (status
        ? `\n${'─'.repeat(60)}\n## 四、任务当前状态（来自 PowerContext）\n\n`
          + `已完成：${status.done.length} 条\n待办：${status.todo.join('；') || '无'}\n已验证：${status.verified.join('；') || '无'}\n`
        : '');

    if (args.out) {
      writeFileSync(args.out, text, 'utf8');
      console.log(`已写入 ${args.out}（${text.length} 字符）`);
    } else {
      console.log(text);
    }
  });
  process.exit(0);
}

if (cmd === 'status') {
  if (args.set) {
    const r = await pc.remember(String(args.set));
    console.log('已保存：', JSON.stringify(r).slice(0, 200));
  } else {
    const entries = await pc.listAll(50);
    console.log(`共 ${entries.length} 条任务记录：`);
    for (const e of entries) console.log(`  [${e.kind}/${e.state}] ${e.artifact_id}  ${e.text}`);
    const s = pc.summarize(entries);
    console.log('\n已完成：', s.done.length, '| 待办：', s.todo.length, '| 已验证：', s.verified.length);
  }
  process.exit(0);
}

console.log(`用法：
  node context/cli.mjs ingest
  node context/cli.mjs context --task "任务描述" [--json] [--out 文件]
  node context/cli.mjs status --set "文本"
  node context/cli.mjs status
  node context/cli.mjs stats`);
process.exit(cmd ? 1 : 0);
