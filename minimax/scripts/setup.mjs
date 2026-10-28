#!/usr/bin/env node
/**
 * 一键准备环境（降低评审上手成本）
 *
 *   node scripts/setup.mjs
 *
 * 依次做：
 *   1. 检查 Node 版本与依赖
 *   2. 检查 PowerContext 是否可用；不可用则尝试通过 uv 安装
 *   3. 生成配置文件（若不存在）
 *   4. 后台启动 PowerContext 服务并等待就绪
 *
 * 不修改任何交付文件；失败时给出下一步该执行什么。
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..');
const PC_DIR = resolve(ROOT, '..', 'powercontext');
const ENV_FILE = join(PC_DIR, '.env');
const BASE = 'http://127.0.0.1:8000';

const ok = (m) => console.log(`  \u2705 ${m}`);
const warn = (m) => console.log(`  \u26a0\ufe0f  ${m}`);
const bad = (m) => console.log(`  \u274c ${m}`);

function whichPowercontext() {
  // 1) PATH 里直接有
  try {
    const v = execFileSync('powercontext', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 });
    return { found: true, how: 'powercontext (PATH)', version: v.trim().split('\n').pop() };
  } catch { /* next */ }

  // 2) uv tool run
  try {
    const v = execFileSync('uv', ['tool', 'run', 'powercontext', '--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
    return { found: true, how: 'uv tool run powercontext', version: v.trim().split('\n').pop() };
  } catch { /* next */ }

  // 3) 常见安装位置
  const candidates = [
    join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'powercontext.exe' : 'powercontext'),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const v = execFileSync(p, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 });
      return { found: true, how: p, version: v.trim().split('\n').pop() };
    } catch { /* next */ }
  }
  return { found: false };
}

async function ready(timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(BASE + '/health/ready', { signal: AbortSignal.timeout(3000) });
      if (r.ok) return true;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

console.log('=== 1. Node 与依赖 ===');
const major = Number(process.versions.node.split('.')[0]);
if (major >= 22) ok(`Node.js v${process.versions.node}`);
else { bad(`Node.js v${process.versions.node} 低于 22，请升级后再继续`); process.exit(1); }

if (existsSync(join(ROOT, 'node_modules', 'mysql2'))) ok('依赖已安装');
else { bad('依赖未安装，请先在 minimax/ 下执行：npm install'); process.exit(1); }

console.log('\n=== 2. PowerContext ===');

// 已经在跑就直接结束
try {
  const r = await fetch(BASE + '/health/ready', { signal: AbortSignal.timeout(3000) });
  if (r.ok) { ok(`服务已在运行：${BASE}`); console.log('\n环境就绪，可以执行：npm run verify'); process.exit(0); }
} catch { /* not running */ }

const pc = whichPowercontext();
if (pc.found) {
  ok(`已安装：${pc.how}  ${pc.version || ''}`);
} else {
  warn('未找到 PowerContext，尝试用 uv 安装 …');
  try {
    execFileSync('uv', ['tool', 'install', '--force', 'powercontext[cli,server]==1.4.1'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 600000,
    });
    ok('安装完成');
  } catch (e) {
    bad('自动安装失败：' + String(e.message).slice(0, 120));
    console.log(`
  请手动执行：
    pip install uv
    uv tool install --force "powercontext[cli,server]==1.4.1"
    powercontext config init --template -o ../powercontext/.env
    powercontext server run --env-file ../powercontext/.env

  详细步骤见 README「四、配置步骤」第 2 节。`);
    process.exit(1);
  }
}

console.log('\n=== 3. 配置文件 ===');
mkdirSync(PC_DIR, { recursive: true });
if (existsSync(ENV_FILE)) {
  ok(`已存在：${ENV_FILE}`);
} else {
  try {
    execFileSync('powercontext', ['config', 'init', '--template', '-o', ENV_FILE], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000,
    });
    ok(`已生成：${ENV_FILE}`);
  } catch (e) {
    bad('生成配置失败：' + String(e.message).slice(0, 120));
    console.log('  可手动执行：powercontext config init --template -o ' + ENV_FILE);
    process.exit(1);
  }
}

console.log('\n=== 4. 启动服务 ===');
const child = spawn('powercontext', ['server', 'run', '--env-file', ENV_FILE], {
  detached: true,
  stdio: 'ignore',
  shell: process.platform === 'win32',
});
child.unref();

if (await ready(60000)) {
  ok(`服务已就绪：${BASE}`);
  console.log('\n环境准备完成，可以执行：npm run verify');
} else {
  bad('服务 60 秒内未就绪');
  console.log(`
  请手动在新窗口执行并保持不关闭：
    powercontext server run --env-file "${ENV_FILE}"
  看到 "PowerContext Server is ready" 后再运行 npm run verify`);
  process.exit(1);
}
