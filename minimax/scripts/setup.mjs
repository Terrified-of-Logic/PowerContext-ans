#!/usr/bin/env node
/**
 * 一键准备环境
 *
 *   node scripts/setup.mjs
 *
 * 目标：让评审在干净环境里一条命令完成 PowerContext 的准备。
 *
 *   1. 检查 Node 版本与依赖
 *   2. 若 PowerContext 已在运行 → 直接结束
 *   3. 找不到 powercontext 时：自动找 uv，没有 uv 就装 uv，再用 uv 装 PowerContext
 *   4. 使用仓库自带的 powercontext.env（无需 config init）
 *   5. 后台启动服务并等待就绪
 *
 * 全程使用国内 PyPI 镜像（可用 UV_DEFAULT_INDEX 覆盖），避免拉包超时。
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..');
const ENV_FILE = join(ROOT, 'powercontext.env');
const BASE = 'http://127.0.0.1:8000';
const MIRROR = process.env.UV_DEFAULT_INDEX || 'https://pypi.tuna.tsinghua.edu.cn/simple';
const PC_SPEC = 'powercontext[cli,server]==1.4.1';

const ok = (m) => console.log(`  \u2705 ${m}`);
const warn = (m) => console.log(`  \u26a0\ufe0f  ${m}`);
const bad = (m) => console.log(`  \u274c ${m}`);

function tryExec(cmd, args, opts = {}) {
  try {
    const out = execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: opts.timeout ?? 60000,
      env: { ...process.env, UV_DEFAULT_INDEX: MIRROR },
    });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}`, err: e };
  }
}

/** 找一个可用的 python，用于安装 uv */
function findPython() {
  for (const [cmd, args] of [
    ['python', ['-c', 'print(1)']],
    ['python3', ['-c', 'print(1)']],
    ['py', ['-3', '-c', 'print(1)']],
  ]) {
    const r = tryExec(cmd, args, { timeout: 15000 });
    if (r.ok) return { cmd, extra: args.slice(0, args.length - 2) };
  }
  return null;
}

/** 找可用的 uv */
function findUv() {
  const direct = tryExec('uv', ['--version']);
  if (direct.ok) return { how: 'uv (PATH)' };

  const py = findPython();
  if (py) {
    const viaPy = tryExec(py.cmd, [...py.extra, '-m', 'uv', '--version']);
    if (viaPy.ok) return { how: `${py.cmd} -m uv`, py };
  }

  const localExe = join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'uv.exe' : 'uv');
  if (existsSync(localExe)) {
    const r = tryExec(localExe, ['--version']);
    if (r.ok) return { how: localExe, exe: localExe };
  }
  return null;
}

/** 找可用的 powercontext
 *  优先按「文件是否存在」判断，不依赖能否执行 --version，
 *  这样在没有子进程权限的环境里也能正确识别已安装的 CLI。
 */
function findPowercontext() {
  const exe = join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'powercontext.exe' : 'powercontext');
  if (existsSync(exe)) return { cmd: exe, args: [] };

  const r = tryExec('powercontext', ['--version'], { timeout: 30000 });
  if (r.ok) return { cmd: 'powercontext', args: [] };

  const uv = findUv();
  if (uv) {
    const t = tryExec('uv', ['tool', 'run', 'powercontext', '--version'], { timeout: 120000 });
    if (t.ok) return { cmd: 'uv', args: ['tool', 'run', 'powercontext'] };
  }
  return null;
}

async function ready(timeoutMs = 90000) {
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
else { bad(`Node.js v${process.versions.node} 低于 22，请升级`); process.exit(1); }

if (existsSync(join(ROOT, 'node_modules', 'mysql2'))) ok('依赖已安装');
else { bad('依赖未安装，请先在 minimax/ 下执行：npm install'); process.exit(1); }

console.log('\n=== 2. PowerContext 服务 ===');
let alreadyUp = false;
try {
  const r = await fetch(BASE + '/health/ready', { signal: AbortSignal.timeout(3000) });
  if (r.ok) { ok(`服务已在运行：${BASE}`); alreadyUp = true; }
} catch { /* not running */ }
if (alreadyUp) { console.log('\n环境就绪，可以执行：npm run verify'); process.exit(0); }
warn('服务未运行，开始准备');

let pc = findPowercontext();
if (pc) {
  ok(`已安装：${[pc.cmd, ...pc.args].join(' ')}`);
} else {
  warn('未找到 powercontext，准备安装');

  let uv = findUv();
  if (!uv) {
    warn('未找到 uv，尝试安装 …');
    const py = findPython();
    if (!py) {
      bad('未找到 Python，无法自动安装 uv');
      console.log('\n  请手动安装 uv 后重试，或参考 README「四、配置步骤」第 2 节。');
      process.exit(1);
    }
    const r = tryExec(py.cmd, [...py.extra, '-m', 'pip', 'install', 'uv', '-i', MIRROR], { timeout: 600000 });
    if (r.ok) ok('uv 安装完成');
    else {
      bad('uv 安装失败');
      console.log('  ' + (r.out || '').split('\n').slice(-3).join('\n  '));
      console.log(`\n  手动执行：${py.cmd} -m pip install uv -i ${MIRROR}`);
      process.exit(1);
    }
    uv = findUv();
  }
  ok(`uv 可用：${uv.how}`);

  warn('安装 PowerContext 1.4.1（走国内镜像，约 1–3 分钟）…');
  const inst = tryExec('uv', ['tool', 'install', '--force', PC_SPEC], { timeout: 900000 });
  if (inst.ok) ok('PowerContext 安装完成');
  else {
    bad('PowerContext 安装失败');
    console.log('  ' + (inst.out || '').split('\n').slice(-4).join('\n  '));
    console.log(`\n  手动执行：
    pip install uv
    UV_DEFAULT_INDEX="${MIRROR}" uv tool install --force "${PC_SPEC}"`);
    process.exit(1);
  }
  pc = findPowercontext();
  if (!pc) { bad('安装后仍找不到 powercontext'); process.exit(1); }
}

console.log('\n=== 3. 配置文件 ===');
if (!existsSync(ENV_FILE)) {
  bad(`缺少 ${ENV_FILE}（仓库应自带该文件）`);
  process.exit(1);
}
ok(`使用仓库自带配置：${ENV_FILE}`);
ok('basic / 免模型 / SQLite，无需推理 API');

console.log('\n=== 4. 启动服务 ===');
// 不套 shell：Windows 上 shell:true 会多一层 cmd.exe，父进程退出时子进程会被一起结束
const child = spawn(pc.cmd, [...pc.args, 'server', 'run', '--env-file', ENV_FILE], {
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
});
child.unref();

if (await ready(90000)) {
  ok(`服务已就绪：${BASE}`);
  console.log('\n环境准备完成，可以执行：npm run verify');
} else {
  console.log('');
  warn('后台启动未成功（部分受限环境不允许创建常驻子进程）');
  console.log(`
  这是最后一步，手动执行即可，不影响其他验收项：

    新开一个窗口，执行并保持不关闭：
      "${pc.cmd}" ${pc.args.join(' ')} server run --env-file "${ENV_FILE}"

    看到 "PowerContext Server is ready" 后，回到原窗口执行：
      npm run verify
`);
  process.exit(1);
}
