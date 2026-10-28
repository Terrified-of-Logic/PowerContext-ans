# Linux（WSL）嵌入式 seekdb 路径验证

Windows 本机上 `@oceanbase/seekdb-node@1.4.0` 的嵌入式实例启动失败（`fail to init observer`，seekdb 1.4.0 Windows 构建环境问题），
为验证 README 默认的**嵌入式方式**（判题机为 Linux 时使用的方式），在 WSL Ubuntu 24.04 上用 Linux 原生包完整跑了一遍。

## 环境

- WSL2 Ubuntu 24.04（Linux 5.15 x86_64）
- Node.js v22.20.0（官方 linux-x64 tarball）
- `@oceanbase/seekdb-node@1.4.0` + `@oceanbase/seekdb-node-linux-x64-gnu@1.4.0`
- npm registry: registry.npmmirror.com
- 说明：`npm install` 时跳过 install scripts（`--ignore-scripts`）。onnxruntime-node 的 postinstall 需要访问 GitHub Releases 下载构建列表，
  WSL 网络下 302/不通；本次只验证 seekdb 嵌入式服务端，不需要 Node 侧 ONNX 运行时（浏览器端 / 前端依赖由 npm 正常安装）。
  正常 Linux 网络环境下直接 `npm install` 即可。

## 步骤

```bash
# 1. 准备 Node 22
curl -fsSL -o node-v22.20.0-linux-x64.tar.xz https://nodejs.org/dist/v22.20.0/node-v22.20.0-linux-x64.tar.xz
tar -xJf node-v22.20.0-linux-x64.tar.xz
export PATH="$PWD/node-v22.20.0-linux-x64/bin:$PATH"

# 2. 拷贝应用（stepfun 目录）
rsync -a --exclude node_modules --exclude .cache --exclude data stepfun/ /home/roftacd/stepfun-app/
cd /home/roftacd/stepfun-app

# 3. 安装依赖（正常网络直接 npm install；本次因 onnxruntime-node postinstall 网络问题加 --ignore-scripts）
npm install --ignore-scripts

# 4. 启动嵌入式 seekdb + 后端
node server/index.mjs
```

启动日志：

```
[seekdb] 启动嵌入式实例 …
[seekdb] 数据目录: /home/roftacd/stepfun-app/data
[seekdb] endpoint: {"transport":"unix_socket","user":"root","unixSocket":"/tmp/pylibseekdb-uds-89535-pq1Dod/run/sql.sock"}
[seekdb] 版本: 5.7.25-OceanBase seekdb-v1.4.0.0
[seekdb] 建表完成，向量索引 HNSW 已启用
[seekdb] 全文索引已启用（ngram 分词）
[server] http://127.0.0.1:8787  向量索引=hnsw 关键词=fulltext-ngram 混合=single-sql
```

## 实测结果

| 步骤 | 结果 |
|---|---|
| 嵌入式 seekdb 启动 | **4–5 秒**就绪（unix socket 传输） |
| `/api/health` | `{"ok":true,"version":"5.7.25-OceanBase seekdb-v1.4.0.0","vectorIndex":"hnsw","keyword":"fulltext-ngram","hybrid":"single-sql"}` |
| `/api/ingest`（3 块） | `inserted=3, replaced=0, visibleChunks=3, writeMs=60` |
| `/api/stats` | `docs=3, files=[{docId:"linux.md",chunks:3}]` |
| 3 条查询 top-1 命中 | 3/3（searchMs = 12 / 8 / 5 ms） |
| 重启后持久化 | 重新启动实例后 `docs=3`，`vectorIndex=hnsw`、`keyword=fulltext-ngram`、`hybrid=single-sql` 保持 |

## 结论

- README 默认的嵌入式启动方式在 Linux 下可用，索引（HNSW + FULLTEXT ngram）与单条 SQL 混合检索均正常；
- 写入提交后新块立即可见，重启后知识库状态（会话状态）从 seekdb 读回一致；
- 与 Windows 远程模式下的实测（`eval/out/e2e-api.json`）结果一致。
