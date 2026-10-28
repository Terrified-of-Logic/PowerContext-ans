#!/usr/bin/env node
/**
 * 一键自查：对着「六项必做」逐条检查，打印 PASS / FAIL
 *
 *   node scripts/verify.mjs
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
const record = (item, ok, detail) => {
  results.push({ item, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${item}  ${detail ? '— ' + detail : ''}`);
};

function run(file, argv = [], timeout = 120000) {
  try {
    const out = execFileSync(process.execPath, [join(ROOT, file), ...argv], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout,
    });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}`, code: e.status };
  }
}

console.log('=== 1. 依赖与环境 ===');
const major = Number(process.versions.node.split('.')[0]);
record('Node.js 版本 ≥ 22', major >= 22, `当前 v${process.versions.node}`);
record('依赖已安装', existsSync(join(ROOT, 'node_modules', 'mysql2')) && existsSync(join(ROOT, 'node_modules', '@oceanbase', 'seekdb-node')), 'node_modules 检查');

let pc = { ok: false, out: '' };
try {
  const r = await fetch('http://127.0.0.1:8000/health/ready', { signal: AbortSignal.timeout(5000) });
  pc = { ok: r.ok, out: 'HTTP ' + r.status };
} catch (e) {
  pc = { ok: false, out: e.message };
}
record('PowerContext 服务在运行', pc.ok, pc.ok ? 'http://127.0.0.1:8000' : '未启动 —— 第 2 步不可用，必做项「状态能够复用」会失败');

console.log('\n=== 2. 数据库参与（seekdb）===');
const ing = run('context/cli.mjs', ['ingest']);
const ingOk = ing.ok && /写入 seekdb：\d+ 条/.test(ing.out);
const nIng = (ing.out.match(/写入 seekdb：(\d+) 条/) || [])[1];
record('资料写入 seekdb', ingOk,
  ingOk ? `${nIng} 条`
        : (ing.out ? `输出：${ing.out.replace(/\s+/g, ' ').slice(0, 120)}`
                   : '子进程未产生任何输出（可能无法执行子进程，或 seekdb 启动失败）'));

const stats = run('context/cli.mjs', ['stats']);
const nStats = (stats.out.match(/库内条目数：\s*(\d+)/) || [])[1];
record('库内可查询', stats.ok && Boolean(nStats), nStats ? `${nStats} 条` : (stats.out ? stats.out.replace(/\s+/g, ' ').slice(0, 100) : '无输出'));

console.log('\n=== 3. 上下文正确 ===');
const ctx = run('context/cli.mjs', ['context', '--task', '实现按状态过滤：只返回指定状态的订单']);
const hasSpec = /适用的规格条目/.test(ctx.out) && /R1 按状态过滤/.test(ctx.out);
const hasCode = /需要修改的代码/.test(ctx.out) && /src\/orders\.js/.test(ctx.out);
const hasTest = /用于验证的测试/.test(ctx.out) && /按状态过滤/.test(ctx.out);
record('输出含规格条目', hasSpec);
record('输出含代码文件与符号', hasCode && /queryOrders/.test(ctx.out));
record('输出含验证测试', hasTest);
record('附任务状态（PowerContext）', pc.ok ? /任务当前状态/.test(ctx.out) : false, pc.ok ? '' : '需先启动 PowerContext');

console.log('\n=== 4. 代码修改有效性（改前基线）===');
const t = run('business/test/orders.test.js');
const m = t.out.match(/pass (\d+)[\s\S]*?fail (\d+)/);
const passN = m ? Number(m[1]) : -1;
const failN = m ? Number(m[2]) : -1;
record('改前基线：目标用例失败、回归用例通过', passN === 9 && failN === 2,
  m ? `pass ${passN} / fail ${failN}（期望 9 / 2）`
    : (t.out ? `无法解析测试输出：${t.out.replace(/\s+/g, ' ').slice(0, 100)}` : '测试子进程未产生输出'));

console.log('\n=== 5. 交付材料完整性 ===');
for (const [label, p] of [
  ['README（运行说明）', 'README.md'],
  ['验证样例', 'docs/验证样例.md'],
  ['代码与测试', 'docs/代码与测试.md'],
  ['技术使用记录', 'docs/技术使用记录.md'],
  ['一页技术说明', 'docs/技术说明.md'],
  ['MiniMax 开发记录', 'agent/runs/2026-10-27T14-42-33/response.md'],
  ['改前代码快照', 'agent/runs/2026-10-27T14-42-33/orders.before.js'],
  ['改后代码快照', 'agent/runs/2026-10-27T14-42-33/patched-orders.js'],
]) {
  record(label, existsSync(join(ROOT, p)), p);
}

console.log('\n=== 汇总 ===');
const passed = results.filter((r) => r.ok).length;
console.log(`${passed} / ${results.length} 项通过`);
const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.log('\n未通过：');
  for (const f of failed) console.log(`  - ${f.item}  ${f.detail || ''}`);
}
process.exit(failed.length ? 1 : 0);
