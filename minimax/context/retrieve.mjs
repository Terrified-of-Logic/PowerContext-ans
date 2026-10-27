/**
 * 检索与上下文组装
 *
 * 给定一个任务描述，从 seekdb 里取出：
 *   - 适用的规格条目
 *   - 需要修改的代码文件与符号
 *   - 用于验证功能与兼容性的测试
 * 并组装成可以交给开发助手的上下文。
 */

/** 中英文混合分词：英文按词，中文按 2-gram */
export function tokenize(text) {
  const tokens = new Set();
  const s = String(text || '');

  for (const m of s.matchAll(/[A-Za-z][A-Za-z0-9_]{1,}/g)) tokens.add(m[0].toLowerCase());

  for (const m of s.matchAll(/[\u4e00-\u9fa5]{2,}/g)) {
    const seg = m[0];
    for (let i = 0; i < seg.length - 1; i++) tokens.add(seg.slice(i, i + 2));
    if (seg.length >= 3) tokens.add(seg);
  }
  return [...tokens];
}

function scoreRow(row, tokens) {
  const content = (row.content || '').toLowerCase();
  const heading = (row.heading || '').toLowerCase();
  const symbol = (row.symbol || '').toLowerCase();

  let score = 0;
  for (const t of tokens) {
    const inContent = content.split(t).length - 1;
    const inHeading = heading.split(t).length - 1;
    const inSymbol = symbol.split(t).length - 1;
    score += inContent + inHeading * 4 + inSymbol * 4;
  }

  // 规格条目略加权：规格是行为的唯一依据
  if (row.kind === 'spec') score *= 1.4;
  return score;
}

/**
 * @param {Array} rows  从 seekdb 取出的全部条目
 * @param {string} task 任务描述
 * @param {{specs?:number, code?:number, tests?:number}} limits
 */
export function buildContext(rows, task, limits = {}) {
  const tokens = tokenize(task);
  const scored = rows
    .map((r) => ({ ...r, score: Number(scoreRow(r, tokens).toFixed(2)) }))
    .sort((a, b) => b.score - a.score);

  const pick = (kind, n) => scored.filter((r) => r.kind === kind).slice(0, n);
  const noScore = (kind) => scored.filter((r) => r.kind === kind && r.score === 0);

  const specs = pick('spec', limits.specs ?? 3);
  let code = pick('code', limits.code ?? 1);
  let tests = pick('test', limits.tests ?? 3);

  // 兜底：任务描述没命中任何条目时，给出该类型的全部条目，
  // 保证「输出包含必要来源」，而不是返回空上下文
  const fill = (list, kind, n) => (list.length ? list : noScore(kind).slice(0, n));
  code = fill(code, 'code', limits.code ?? 1);
  tests = fill(tests, 'test', limits.tests ?? 3);

  return { task, tokens, specs, code, tests, total: rows.length };
}

/** 渲染成给开发助手看的大段文本 */
export function renderMarkdown(ctx) {
  const line = '─'.repeat(60);
  const out = [];
  out.push('# 开发上下文');
  out.push('');
  out.push(`任务：${ctx.task}`);
  out.push('');

  out.push(line);
  out.push('## 一、适用的规格条目');
  out.push('');
  for (const s of ctx.specs) {
    out.push(`### [${s.path}] ${s.heading}   相关度 ${s.score}`);
    out.push(s.content.replace(/^#{2,4}\s+.*\n/, '').trim());
    out.push('');
  }

  out.push(line);
  out.push('## 二、需要修改的代码');
  out.push('');
  for (const c of ctx.code) {
    out.push(`### ${c.path}    符号：${c.symbol || '（无导出）'}   相关度 ${c.score}`);
    out.push('```js');
    out.push(c.content);
    out.push('```');
    out.push('');
  }

  out.push(line);
  out.push('## 三、用于验证的测试');
  out.push('');
  for (const t of ctx.tests) {
    out.push(`### [${t.path}] ${t.heading}   相关度 ${t.score}`);
    out.push('```js');
    out.push(t.content);
    out.push('```');
    out.push('');
  }
  return out.join('\n');
}
