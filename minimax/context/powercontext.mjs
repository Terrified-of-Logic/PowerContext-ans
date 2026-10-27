/**
 * PowerContext 客户端：保存 / 读回任务状态
 *
 * 只用到两个接口：
 *   POST /v1/memory/remember        写入
 *   POST /v1/memory/entries/list    读回（含重启后复用）
 */

const BASE = process.env.POWERCONTEXT_BASE || 'http://127.0.0.1:8000';
let cachedScope = process.env.POWERCONTEXT_SCOPE || null;

async function call(method, path, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
    if (!r.ok) {
      const err = new Error(`PowerContext ${method} ${path} → ${r.status}`);
      err.body = json;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

export async function scopeId() {
  if (cachedScope) return cachedScope;
  const d = await call('GET', '/v1/scopes/default');
  cachedScope = d.scope_id || d.scope?.scope_id;
  if (!cachedScope) throw new Error('取不到默认 scope');
  return cachedScope;
}

export async function available() {
  try {
    await call('GET', '/health/ready');
    return true;
  } catch {
    return false;
  }
}

/** 保存一条任务状态 */
export async function remember(text, kind = 'state') {
  const scope_id = await scopeId();
  return call('POST', '/v1/memory/remember', { scope_id, kind, text });
}

/** 读回全部任务记录 */
export async function listAll(limit = 50) {
  const scope_id = await scopeId();
  const d = await call('POST', '/v1/memory/entries/list', { scope_id, limit });
  return (d.entries || []).map((e) => ({
    artifact_id: e.artifact?.artifact_id,
    revision: e.artifact?.revision,
    kind: e.kind,
    state: e.state,
    text: e.text,
  }));
}

/** 按语义/关键词检索 */
export async function search(query, limit = 10) {
  const scope_id = await scopeId();
  const d = await call('POST', '/v1/memory/search', { scope_id, query, limit });
  return (d.hits || []).map((h) => ({
    score: h.score,
    kind: h.memory?.kind,
    text: h.memory?.text,
    artifact_id: h.memory?.artifact?.artifact_id,
  }));
}

/** 从记录里挑出「已完成 / 待办 / 已验证」 */
export function summarize(entries) {
  const done = [], todo = [], verified = [];
  for (const e of entries) {
    const t = e.text || '';
    if (/待办|TODO|未开始/.test(t)) todo.push(t);
    else if (/验证|通过|测试/.test(t)) verified.push(t);
    else done.push(t);
  }
  return { done, todo, verified };
}
