/**
 * MiniMax 调用封装
 *
 * 只用最基础的一次对话补全，不依赖 SDK。
 * 需要的环境变量：
 *   MINIMAX_API_KEY   必填
 *   MINIMAX_BASE_URL  可选，默认 https://api.minimaxi.com/v1
 *   MINIMAX_MODEL     可选，默认 MiniMax-Text-01
 */

const BASE = process.env.MINIMAX_BASE_URL || 'https://api.minimaxi.com/v1';
const MODEL = process.env.MINIMAX_MODEL || 'MiniMax-Text-01';

export function hasKey() {
  return Boolean(process.env.MINIMAX_API_KEY);
}

/**
 * @param {Array<{role:string, content:string}>} messages
 * @param {{temperature?:number, timeoutMs?:number}} opts
 * @returns {Promise<{text:string, usage:object, raw:object}>}
 */
export async function chat(messages, opts = {}) {
  const key = process.env.MINIMAX_API_KEY;
  if (!key) throw new Error('缺少环境变量 MINIMAX_API_KEY');

  const body = {
    model: MODEL,
    messages,
    temperature: opts.temperature ?? 0.1,
    max_tokens: opts.maxTokens ?? 4096,
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 120000);

  try {
    const r = await fetch(`${BASE}/text/chatcompletion_v2`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });

    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = null; }

    if (!r.ok) {
      const err = new Error(`MiniMax ${r.status}: ${text.slice(0, 300)}`);
      err.status = r.status;
      err.raw = json;
      throw err;
    }

    const content =
      json?.choices?.[0]?.message?.content ??
      json?.reply ??
      (typeof text === 'string' ? text : '');

    if (!content) throw new Error('MiniMax 返回内容为空：' + text.slice(0, 200));

    return { text: content, usage: json?.usage || {}, raw: json };
  } finally {
    clearTimeout(timer);
  }
}

/** 从模型输出里抽出第一个 ```js / ```javascript 代码块 */
export function extractCode(reply) {
  const m = reply.match(/```(?:js|javascript|jsx|ts)?\s*\n([\s\S]*?)```/);
  return m ? m[1].trim() : null;
}
