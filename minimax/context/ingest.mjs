/**
 * 资料切分：把 specs / src / test 切成可检索的条目
 *
 * 切分策略按类型区分，因为三类资料的结构不同：
 *   - 规格：按 Markdown 标题切，一个条目就是一条需求
 *   - 代码：整个文件当一个条目，记录导出符号名
 *   - 测试：按 test(...) 块切，一个条目就是一条用例
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** 按 Markdown 标题切分 */
function splitSpec(text, filePath) {
  const rows = [];
  const lines = text.split(/\r?\n/);
  let heading = '';
  let buf = [];

  const flush = () => {
    const content = buf.join('\n').trim();
    if (content.length >= 20) rows.push({ path: filePath, kind: 'spec', heading, symbol: '', content });
    buf = [];
  };

  for (const line of lines) {
    const m = line.match(/^(#{2,4})\s+(.+)$/);
    if (m) {
      flush();
      heading = m[2].trim();
      buf.push(line);
    } else {
      buf.push(line);
    }
  }
  flush();
  return rows;
}

/** 代码：整文件一个条目，提取导出符号 */
function splitCode(text, filePath) {
  const symbols = [];
  for (const m of text.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/g)) symbols.push(m[1]);
  for (const m of text.matchAll(/export\s+const\s+([A-Za-z0-9_]+)/g)) symbols.push(m[1]);

  return [{ path: filePath, kind: 'code', heading: '', symbol: symbols.join(','), content: text.trim() }];
}

/** 测试：按 test('...') 块切 */
function splitTest(text, filePath) {
  const rows = [];
  const parts = text.split(/\ntest\(/);
  for (let i = 1; i < parts.length; i++) {
    const body = 'test(' + parts[i];
    const nameMatch = parts[i].match(/^['"`]([^'"`]+)['"`]/);
    const name = nameMatch ? nameMatch[1] : '';
    rows.push({ path: filePath, kind: 'test', heading: name, symbol: '', content: ('test(' + parts[i]).trim() });
  }
  // 头部（import 等）不单独成条
  return rows;
}

export function collect(businessDir) {
  const files = walk(businessDir).filter((f) => /\.(md|js|mjs)$/.test(f));
  const rows = [];

  for (const f of files) {
    const rel = relative(businessDir, f).replace(/\\/g, '/');
    const text = readFileSync(f, 'utf8');
    if (rel.startsWith('specs/')) rows.push(...splitSpec(text, rel));
    else if (rel.startsWith('src/')) rows.push(...splitCode(text, rel));
    else if (rel.startsWith('test/')) rows.push(...splitTest(text, rel));
  }
  return rows;
}
