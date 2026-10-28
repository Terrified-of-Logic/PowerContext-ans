#!/usr/bin/env node
/**
 * 一键自查：对着「六项必做」逐条检查
 *
 *   node scripts/verify.mjs
 *
 * 三种结果：
 *   PASS  已确认通过
 *   SKIP  无法自动判定（子进程无输出、服务未启动等），会提示手动执行什么
 *   FAIL  确认不通过（有明确证据）
 *
 * 只做检查和执行，不修改任何交付文件。
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..');

const results = [];
const record = (item, status, detail) => {
  results.push({ item, status, detail });
  console.log(`${status.padEnd(4)}  ${item}${detail ? '  — ' + detail : ''}`);
};
const pass = (i, d) => record(i, 'PASS', d);
const skip = (i, d) => record(i, 'SKIP', d);
const fail = (i, d) => record(i, 'FAIL', d);

function run(file, argv = [], timeout = 120000) {
  try {
    const out = execFileSync(process.execPath, [join(ROOT, file), ...argv], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout,
    });
    return { ok: true, out, ran: out.trim().length > 0 };
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`;
    return { ok: false, out, ran: out.trim().length > 0 };
  }
}

console.log('=== 一、能够运行 ===');
const major = Number(process.versions.node.split('.')[0]);
if (major >= 22) pass('Node.js 版本 ≥ 22', `v${process.versions.node}`);
else fail('Node.js 版本 ≥ 22', `当前 v${process.versions.node}`);

if (existsSync(join(ROOT, 'node_modules', 'mysql2')) && existsSync(join(ROOT, 'node_modules', '@oceanbase', 'seekdb-node'))) {
  pass('依赖已安装', 'mysql2 + @oceanbase/seekdb-node');
} else {
  fail('依赖已安装', '请先执行 npm install');
}

let pcUp = false;
try {
  const r = await fetch('http://127.0.0.1:8000/health/ready', { signal: AbortSignal.timeout(5000) });
  pcUp = r.ok;
} catch { /* not running */ }
if (pcUp) pass('PowerContext 服务在运行', 'http://127.0.0.1:8000');
else skip('PowerContext 服务在运行', '未启动 —— 执行 npm run setup，或按 README 第 2 节手动启动');

console.log('\n=== 二、数据库实际参与（seekdb）===');
const ing = run('context/cli.mjs', ['ingest']);
const nIng = (ing.out.match(/写入 seekdb：(\d+) 条/) || [])[1];
if (nIng) pass('资料写入 seekdb', `${nIng} 条`);
else if (!ing.ran) skip('资料写入 seekdb', '子进程无输出 —— 请手动执行：node context/cli.mjs ingest');
else fail('资料写入 seekdb', ing.out.replace(/\s+/g, ' ').slice(0, 120));

const stats = run('context/cli.mjs', ['stats']);
const nStats = (stats.out.match(/库内条目数：\s*(\d+)/) || [])[1];
if (nStats) pass('库内可查询', `${nStats} 条`);
else if (!stats.ran) skip('库内可查询', '子进程无输出 —— 请手动执行：node context/cli.mjs stats');
else fail('库内可查询', stats.out.replace(/\s+/g, ' ').slice(0, 100));

console.log('\n=== 三、上下文正确 ===');
const ctx = run('context/cli.mjs', ['context', '--task', '实现按状态过滤：只返回指定状态的订单']);
if (!ctx.ran) {
  skip('上下文三要素 + 任务状态', '子进程无输出 —— 请手动执行：node context/cli.mjs context --task "实现按状态过滤"');
} else {
  if (/适用的规格条目/.test(ctx.out) && /R1 按状态过滤/.test(ctx.out)) pass('输出含适用规格条目', 'R1 按状态过滤');
  else fail('输出含适用规格条目');
  if (/需要修改的代码/.test(ctx.out) && /queryOrders/.test(ctx.out)) pass('输出含代码文件与符号', 'orders.js / queryOrders');
  else fail('输出含代码文件与符号');
  if (/用于验证的测试/.test(ctx.out) && /按状态过滤/.test(ctx.out)) pass('输出含验证测试');
  else fail('输出含验证测试');
  if (pcUp) {
    if (/任务当前状态/.test(ctx.out)) pass('附任务状态（来自 PowerContext）');
    else fail('附任务状态（来自 PowerContext）');
  } else {
    skip('附任务状态（来自 PowerContext）', '服务未启动，此项需 PowerContext 运行后确认');
  }
}

console.log('\n=== 四、代码修改有效（改前基线）===');
const t = run('business/test/orders.test.js');
const m = t.out.match(/pass (\d+)[\s\S]*?fail (\d+)/);
if (m) {
  const [, p, f] = m;
  if (Number(p) === 9 && Number(f) === 2) pass('改前基线：目标用例失败、回归用例通过', `pass ${p} / fail ${f}（期望 9 / 2）`);
  else fail('改前基线', `pass ${p} / fail ${f}，期望 9 / 2`);
} else if (!t.ran) {
  skip('改前基线', '测试子进程无输出 —— 请手动执行：node business/test/orders.test.js');
} else {
  fail('改前基线', '无法解析测试输出');
}

console.log('\n=== 五、交付材料完整性 ===');
for (const [label, p] of [
  ['README（运行说明）', 'README.md'],
  ['验证样例', 'docs/验证样例.md'],
  ['代码与测试', 'docs/代码与测试.md'],
  ['技术使用记录', 'docs/技术使用记录.md'],
  ['一页技术说明', 'docs/技术说明.md'],
  ['MiniMax 开发记录', 'agent/runs/2026-10-27T14-42-33/response.md'],
  ['MiniMax 调用统计', 'agent/runs/2026-10-27T14-42-33/usage.json'],
  ['改前代码快照', 'agent/runs/2026-10-27T14-42-33/orders.before.js'],
  ['改后代码快照', 'agent/runs/2026-10-27T14-42-33/patched-orders.js'],
  ['测试日志（改前）', 'agent/runs/2026-10-27T14-42-33/test-before.log'],
  ['测试日志（改后）', 'agent/runs/2026-10-27T14-42-33/test-after.log'],
  ['PowerContext 配置', 'powercontext.env'],
]) {
  if (existsSync(join(ROOT, p))) pass(label, p);
  else fail(label, `缺少 ${p}`);
}

console.log('\n=== 汇总 ===');
const nPass = results.filter((r) => r.status === 'PASS').length;
const nFail = results.filter((r) => r.status === 'FAIL').length;
const nSkip = results.filter((r) => r.status === 'SKIP').length;
console.log(`${nPass} PASS / ${nFail} FAIL / ${nSkip} SKIP  （共 ${results.length} 项）`);

if (nSkip) {
  console.log('\n以下项目无法自动判定，请按提示手动确认：');
  for (const r of results.filter((x) => x.status === 'SKIP')) console.log(`  - ${r.item}：${r.detail || ''}`);
}
if (nFail) {
  console.log('\n以下项目确认未通过：');
  for (const r of results.filter((x) => x.status === 'FAIL')) console.log(`  - ${r.item}：${r.detail || ''}`);
  process.exit(1);
}
if (nSkip) process.exit(2);
console.log('\n全部通过。');
