# 端侧知识库 · seekdb 混合检索

一个迷你知识库：把 `.txt` / `.md` 拖进浏览器，用自然语言提问，直接找回最相关的段落。

- **向量化在浏览器本地完成**（Transformers.js + ONNX Runtime Web，模型跑在 Web Worker 里）；**优先 WebGPU，不支持时自动降级 WASM，界面明确提示当前后端**
- **存储与混合检索全部由 seekdb 完成**：向量距离 + FULLTEXT 全文相关度两路排名、候选截断、RRF 融合都在**一条 SQL** 内执行，不把两路结果拉回客户端拼合
- **量化**：WebGPU 用 FP16（45.23 MB），WASM 用 INT8/q8（22.83 MB），相对 FP32 基线（90.42 MB）压缩 2.00× / 3.96×；量化前后检索质量见 `TECH_REPORT.md` §3.3

技术细节、实测数据与复现方式见 [`TECH_REPORT.md`](./TECH_REPORT.md) 和 [`eval/README.md`](./eval/README.md)。

---

## 一、环境要求

| 项 | 要求 |
|---|---|
| Node.js | **22 及以上**（`@oceanbase/seekdb-node` 要求 `>=22`；本仓库带 `package-lock.json`，依赖版本固定） |
| 浏览器 | Chrome / Edge 等 Chromium 内核（需要 WebAssembly + Web Worker；有 WebGPU 时自动使用） |
| 网络 | 首次加载模型需联网（走魔搭社区，INT8 约 23 MB / FP16 约 45 MB）；之后走浏览器缓存 |

不需要 Docker，不需要单独部署数据库——seekdb 以嵌入式方式在 Node 进程内运行。
（本机 Windows 11 上 seekdb-node 1.4.0 嵌入式实例无法启动，已用 `SEEKDB_REMOTE=1` 连 WSL 里的 seekdb 服务完成本地实测；
Linux 下嵌入式路径已单独验证通过，见 `eval/linux-embedded.md`。判题环境为 Linux 时按默认嵌入式方式即可。）

---

## 二、运行

```bash
# 1. 安装依赖
npm install

# 2. 同时启动后端（8787）和前端（5173）
npm start
```

或者分两个窗口：

```bash
npm run server   # 后端，seekdb 嵌入式实例
npm run dev      # 前端
```

浏览器打开终端里提示的地址（通常是 <http://localhost:5173/>）。

> Windows 用户如果 `npm` 报「禁止运行脚本」，改用 `npm.cmd`；
> 或执行一次 `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`。

### 推理后端

- 默认：检测到 `navigator.gpu` 时用 **WebGPU + FP16**，否则自动降级 **WASM + INT8**；降级原因显示在页面徽标里。
- 强制指定（用于验收降级路径）：`http://localhost:5173/?device=wasm` 或 `?device=webgpu`。
- 徽标示例：`推理后端：WebGPU · FP16` / `推理后端：WASM · INT8（按测试参数强制 WASM…）`。

---

## 三、验收步骤

1. 页面顶部出现 **推理后端徽标**（WebGPU · FP16 或 WASM · INT8）与
   **「模型就绪（512 维 · WebGPU · FP16）· 加载 X.Xs · 预热 XXms」**
2. 知识库状态条显示 seekdb 中的当前状态：`知识库：N 块 / M 个文件 · 向量索引=hnsw · 关键词路=fulltext-ngram · 混合=single-sql`
3. 把 `demo-doc.md` 拖进虚线框（或点“选择文件”），状态条依次显示「向量化 …」「入库 N 块（替换旧块 …）· 端侧向量化 …ms · seekdb 写入+可见校验 …ms」
4. 输入 `向量索引怎么建` 或 `RRF 是什么` 点检索，应命中 `demo-doc.md` 对应小节，关键词高亮，状态条显示：
   `端侧向量化 XXms · seekdb 混合检索 XXms（单条 SQL：single-sql）· 端到端 XXms · 命中 N 条`
5. 重复上传同一文件：块数不增加（`替换旧块 N`），不会产生重复数据；刷新页面后知识库状态从 seekdb 读回，保持一致。
6. 命令行验证：

   ```bash
   curl http://127.0.0.1:8787/api/health
   # {"ok":true,"version":"5.7.25-OceanBase seekdb-v1.4.0.0","docs":N,
   #  "vectorIndex":"hnsw","keyword":"fulltext-ngram","hybrid":"single-sql"}
   curl http://127.0.0.1:8787/api/stats
   # {"ok":true,"docs":N,"files":[{"docId":"demo-doc.md","chunks":13}], ...}
   ```

   `vectorIndex=hnsw` 表示向量索引生效；`full-scan` 表示当前实例不允许建索引，已自动降级（功能不受影响）。

---

## 四、接口

| 接口 | 方法 | 说明 |
|---|---|---|
| `/api/health` | GET | seekdb 版本、文档块数、索引/混检模式 |
| `/api/stats` | GET | 知识库状态：块数、文件列表（会话状态持久化在 seekdb） |
| `/api/ingest` | POST | `{ records: [{doc_id, chunk_index, title, content, vector}] }`；同 doc_id 先删后插，返回 `inserted/replaced/visibleChunks/writeMs` |
| `/api/search` | POST | `{ query, vector, topk }` → `{ hits: [...], searchMs, hybrid, keywordMode }`，每项含 `dist` / `kw_hits`(全文相关度) / `score`(RRF) |

`vector` 必须是 512 维数组，由前端的端侧模型生成。

---

## 五、目录结构

```
.
├── README.md              运行说明（本文件）
├── TECH_REPORT.md         一页技术说明（含量化/性能/质量实测）
├── index.html             页面结构 + 样式
├── vite.config.js         开发服务器，/api 代理到 8787
├── demo-doc.md            演示用文档（拖进页面即可）
├── package.json           固定版本依赖 + 评测脚本
├── src/
│   ├── main.js            分块、批量向量化、入库、检索、渲染、状态展示
│   └── embed.worker.js    端侧推理（WebGPU+FP16 优先，WASM+INT8 自动降级）
├── server/
│   └── index.mjs          seekdb 嵌入式实例 + 单条 SQL 混合检索接口
├── scripts/
│   ├── eval-quality.mjs   FP32/FP16/INT8 检索质量 + 延迟对比
│   ├── smoke-api.mjs      全链路冒烟（向量化 → 入库 → 单条 SQL 混合检索）
│   └── check-sql.mjs      seekdb SQL/DDL 兼容性自检
├── eval/                  实测原始数据、截图、浏览器探针、复现说明
└── data/                  运行时生成，seekdb 数据目录（已在 .gitignore）
```

---

## 六、数据怎么存的

`data/seekdb.db` 是 seekdb 的数据目录，首次运行自动创建；表 `kb_docs` 保存块原文、元数据与 512 维向量。
想清空演示数据，停掉后端、删掉 `data/` 目录、重启即可。

---

## 七、已知限制

- 候选池固定 50（向量路）/ 200（全文路），适合演示规模；上千文档需调大或改用 ANN Top-K 直取
- 中文全文用 ngram 分词，未做同义词/停用词调优；无全文索引的环境下降级 `LIKE`
- 分块是规则切分（标题/段落/句子），不是语义分块
- 重复上传同一文件会整体替换（同 doc_id 先删后插），不保留历史版本
