#!/usr/bin/env node
/**
 * 完整任务流程：检索上下文 → 交给 MiniMax 改代码 → 应用 → 跑测试 → 记录状态
 *
 * 用法：
 *   node agent/run.mjs --task "实现按状态过滤" [--dry-run]
 *
 * --dry-run  只生成上下文和提示词，不调用 MiniMax、不改文件
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { collect } from '../context/ingest.mjs';
import { buildContext, renderMarkdown } from '../context/retrieve.mjs';
import { chat, extractCode, hasKey } from './minimax.mjs';
import * as pc from '../context/powercontext.mjs';

const ROOT = resolve(process.cwd());
const BUSINESS = join(ROOT, 'business');
const TARGET = join(BUSINESS, 'src', 'orders.js');
const TESTFILE = join(BUSINESS, 'test', 'orders.test.js');

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
    return acc;
  }, [])
);

const task = typeof args.task === 'string' ? args.task : '实现按状态过滤：只返回指定状态的订单';
const dryRun = Boolean(args['dry-run']);

function run(cmd, argv) {
  try {
    const out = execFileSync(cmd, argv, { cwd: BUSINESS, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const runDir = join(ROOT, 'agent', 'runs', stamp);
mkdirSync(runDir, { recursive: true });

console.log('=== 任务 ===');
console.log(task);
console.log('运行目录:', runDir);

/* ---------- 1. 检索上下文（资料来自 seekdb） ---------- */
const rows = collect(BUSINESS);
const ctx = buildContext(rows, task);
const contextMd = renderMarkdown(ctx);

// 顺带写进 seekdb，证明数据库真的参与（如果可用）
try {
  const { open, insertAll, reset, count, close } = await import('../context/store.mjs');
  await open(join(ROOT, 'context', 'data'));
  await reset();
  const n = await insertAll(rows);
  const total = await count();
  await close();
  console.log(`\n[seekdb] 已写入 ${n} 条，库内 ${total} 条`);
  ctx.dbItems = total;
} catch (e) {
  console.log('\n[seekdb] 跳过写入：', e.message);
}

writeFileSync(join(runDir, 'context.md'), contextMd, 'utf8');
console.log('[上下文] 已保存 context.md');
console.log(`  规格 ${ctx.specs.length} 条 / 代码 ${ctx.code.length} 条 / 测试 ${ctx.tests.length} 条`);

/* ---------- 2. 记录改前测试结果 ---------- */
const before = run(process.execPath, [TESTFILE]);
writeFileSync(join(runDir, 'test-before.log'), before.out, 'utf8');
console.log(`\n[改前] 测试 ${before.ok ? '通过' : '失败'}`);

/* ---------- 3. 组装提示词 ---------- */
const prompt = [
  '你是一名开发助手。下面是某仓库的规格、代码和测试，请完成指定任务。',
  '',
  '任务：' + task,
  '',
  contextMd,
  '',
  '要求：',
  '1. 只输出修改后的完整文件内容，放在一个 ```js 代码块里，不要输出解释。',
  '2. 不得修改函数签名；不得修改传入数组。',
  '3. 已通过的测试必须仍然通过。',
].join('\n');

writeFileSync(join(runDir, 'prompt.md'), prompt, 'utf8');
console.log('[提示词] 已保存 prompt.md');

if (dryRun) {
  console.log('\n--dry-run：不调用 MiniMax，流程到此结束');
  process.exit(0);
}

if (!hasKey()) {
  console.error('\n缺少 MINIMAX_API_KEY，无法调用模型。');
  console.error('可先加 --dry-run 查看上下文与提示词。');
  process.exit(2);
}

/* ---------- 4. 调用 MiniMax ---------- */
console.log('\n[MiniMax] 调用中 …');
const t0 = Date.now();
const res = await chat([
  { role: 'system', content: '你是一名严谨的开发助手，严格按规格修改代码。' },
  { role: 'user', content: prompt },
]);
const ms = Date.now() - t0;
writeFileSync(join(runDir, 'response.md'), res.text, 'utf8');
writeFileSync(join(runDir, 'usage.json'), JSON.stringify(res.usage, null, 2), 'utf8');
console.log(`[MiniMax] 返回 ${res.text.length} 字符，耗时 ${ms}ms`);

const code = extractCode(res.text);
if (!code) {
  console.error('模型输出里没有代码块，已保存 response.md 供检查');
  process.exit(3);
}
writeFileSync(join(runDir, 'patched-orders.js'), code, 'utf8');

/* ---------- 5. 应用并跑测试 ---------- */
if (existsSync(TARGET)) copyFileSync(TARGET, join(runDir, 'orders.before.js'));
writeFileSync(TARGET, code, 'utf8');
console.log('[应用] 已写入业务代码');

const after = run(process.execPath, [TESTFILE]);
writeFileSync(join(runDir, 'test-after.log'), after.out, 'utf8');
console.log(`[改后] 测试 ${after.ok ? '通过' : '失败'}`);

/* ---------- 6. 记录到 PowerContext ---------- */
const summary = `任务「${task}」：改前测试${before.ok ? '通过' : '失败'}，`
  + `改后测试${after.ok ? '通过' : '失败'}；`
  + `上下文含规格 ${ctx.specs.length} 条、代码 ${ctx.code.length} 条、测试 ${ctx.tests.length} 条；`
  + `MiniMax 耗时 ${ms}ms；运行目录 ${stamp}`;

try {
  const r = await pc.remember(summary, 'state');
  console.log('\n[PowerContext] 已记录任务状态');
  console.log(JSON.stringify(r).slice(0, 200));
} catch (e) {
  console.log('\n[PowerContext] 记录失败：', e.message);
}

console.log('\n=== 完成 ===');
console.log(`产物都在 ${runDir}`);
process.exit(after.ok ? 0 : 1);
