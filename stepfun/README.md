# 端侧知识库 · seekdb 混合检索

一个迷你知识库：把 `.txt` / `.md` 拖进浏览器，用自然语言提问，直接找回最相关的段落。

- **向量化在浏览器本地完成**（Transformers.js + ONNX Runtime Web，模型跑在 Web Worker 里）
- **检索由 seekdb 执行**（向量距离计算、关键词匹配、排序全部下推到 SQL）
- **混合排序用 RRF 融合**两路排名

技术细节见 [`TECH_REPORT.md`](./TECH_REPORT.md)。

---

## 一、环境要求

| 项 | 要求 |
|---|---|
| Node.js | **22 及以上**（`@oceanbase/seekdb-node` 要求 `>=22`） |
| 浏览器 | Chrome / Edge 等 Chromium 内核（需要 WebAssembly + Web Worker） |
| 网络 | 首次加载模型需联网（走魔搭社区，约 25–40 MB）；之后走浏览器缓存 |

不需要 Docker，不需要单独部署数据库——seekdb 以嵌入式方式在 Node 进程内运行。

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

---

## 三、验收步骤

1. 页面顶部状态条出现 **「模型就绪（512 维，q8 量化）· 加载 X.Xs · 预热 XXms」**
2. 把 `demo-doc.md` 拖进虚线框，状态条依次显示「向量化 …」「入库 N 段」
3. 输入 `向量索引怎么建` 或 `RRF 是什么` 点检索
4. 应命中 `demo-doc.md` 的对应小节，关键词高亮，状态条显示：

```
端侧向量化 12ms · seekdb 检索 42ms · 命中 N 条
```

5. 命令行验证数据确实写进去了：

```bash
curl http://127.0.0.1:8787/api/health
# {"ok":true,"version":"5.7.25-OceanBase seekdb-v1.4.0.0","docs":N,"indexMode":"hnsw"}
```

`indexMode` 为 `hnsw` 表示向量索引生效；若为 `full-scan` 表示当前实例不允许建索引，已自动降级（功能不受影响）。

---

## 四、接口

| 接口 | 方法 | 说明 |
|---|---|---|
| `/api/health` | GET | 版本、文档数、索引模式 |
| `/api/ingest` | POST | `{ records: [{doc_id, chunk_index, title, content, vector}] }` |
| `/api/search` | POST | `{ query, vector, topk }` → `{ hits: [...] }`，每项含 `dist` / `kw_hits` / `score` |

`vector` 必须是 512 维数组，由前端的端侧模型生成。

---

## 五、目录结构

```
.
├── README.md              运行说明（本文件）
├── TECH_REPORT.md         一页技术说明
├── index.html             页面结构 + 样式
├── vite.config.js         开发服务器，/api 代理到 8787
├── demo-doc.md            演示用文档（拖进页面即可）
├── src/
│   ├── main.js            分块、批量向量化、入库、检索、渲染
│   └── embed.worker.js    端侧推理（Transformers.js + ONNX，q8 量化）
├── server/
│   └── index.mjs          seekdb 嵌入式实例 + 混合检索接口
└── data/                  运行时生成，seekdb 数据目录（已在 .gitignore）
```

---

## 六、数据怎么存的

`data/seekdb.db` 是 seekdb 的数据目录，首次运行自动创建。
想清空演示数据，停掉后端、删掉 `data/` 目录、重启即可。

---

## 七、已知限制

- 候选池固定 50 条，适合演示规模；上千文档需要调大或改用 ANN 直接取 Top-K
- 关键词路用 `LIKE`，不支持分词，中文长词建议拆成短词查询
- 重复上传同一文件会产生重复块，没有去重
