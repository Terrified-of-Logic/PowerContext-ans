# 技术说明：端侧向量化 + seekdb 混合检索

> 一页纸版本。文中数据均来自提交代码的实际运行（Windows 11 / Chrome 155 / Intel iGPU 与 seekdb `5.7.25-OceanBase seekdb-v1.4.0.0`），
> 原始数据与复现脚本见 [`eval/`](./eval/)：`eval/out/quality.json`、`eval/out/backend-browser.json`、`eval/out/e2e-api.json`。

## 一、要解决的问题

做一个迷你知识库：上传 `.md` / `.txt`，用自然语言提问，直接找回最相关的段落。两条硬约束决定架构：

1. **向量化必须在浏览器本地完成**（数据不出本地，断网可用），且优先用 WebGPU、不支持时自动降级 WASM 并明确提示；
2. **存储与混合检索必须由 seekdb 完成**（不能客户端分别取两路结果再自行拼合）。

## 二、架构

```
浏览器                                        本地 Node 进程
┌──────────────────────────────┐             ┌──────────────────────────────┐
│ UI（原生 JS + Vite）          │             │ Express                      │
│  ├ 文件读取 / 分块             │  HTTP/JSON  │  ├ POST /api/ingest           │
│  ├ Web Worker                │ ──────────► │  ├ POST /api/search           │
│  │   ├ WebGPU + FP16（优先）  │             │  └ GET  /api/health /api/stats│
│  │   └ WASM + INT8（自动降级）│             │         │                    │
│  └ 结果渲染 / 高亮             │ ◄────────── │         ▼                    │
└──────────────────────────────┘             │ seekdb（嵌入式，进程内）       │
                                             │  VECTOR(512) + HNSW          │
                                             │  FULLTEXT(ngram)             │
                                             └──────────────────────────────┘
```

三处关键取舍：

| 决策 | 选择 | 理由 |
|---|---|---|
| 向量化放哪 | 浏览器 Web Worker | 题面要求端侧；Worker 避免阻塞主线程；不同推理后端在 Worker 内自动选择 |
| seekdb 怎么部署 | 嵌入式（进程内） | 评委 `npm install && npm start` 即可跑，无需 Docker、无需单独服务 |
| 混合检索怎么实现 | **单条 SQL 内完成两路检索 + RRF 融合** | 题面要求"检索处理由 seekdb 完成，不得客户端拼合"；见 §四 |

## 三、端侧推理：模型、量化与后端选择

### 3.1 模型来源与版本

- 模型：**`onnx-community/bge-small-zh-v1.5-ONNX`**（`BAAI/bge-small-zh-v1.5` 的 ONNX 转换，512 维，中文语料训练，CLS 池化）。
- 权重来源：**魔搭社区**（ModelScope）镜像，运行时地址 `https://modelscope.cn/models/onnx-community/bge-small-zh-v1.5-ONNX/resolve/master/`；
  本次实测使用的仓库快照 revision = `5b414c2c2d177d066e7bdc32b6ad2a4518a59333`（2026-10-17 上传）。
- 运行时：`@huggingface/transformers@4.3.2`（ONNX Runtime Web），模型权重走浏览器 Cache Storage 缓存。

### 3.2 量化方案与体积

模型仓库同时提供 FP32 / FP16 / INT8 三套 ONNX 权重，本应用按后端选择：

| 精度 | 使用的文件 | 权重大小（onnx 文件合计） | 相对 FP32 压缩比 |
|---|---|---:|---:|
| FP32（基线） | `onnx/model.onnx` + `model.onnx_data` | **90.42 MB** | 1.00× |
| FP16（WebGPU 路径） | `onnx/model_fp16.onnx` + `model_fp16.onnx_data` | **45.23 MB** | **2.00×** |
| INT8 / q8（WASM 路径） | `onnx/model_quantized.onnx` + `model_quantized.onnx_data` | **22.83 MB** | **3.96×** |

（另有 tokenizer.json 0.35 MB；INT8 为 onnx-community 官方 q8 量化权重，本应用不重复量化，仅按后端选文件。）

### 3.3 量化前后检索质量

同管线（Node + onnxruntime，同 CLS 池化 / 查询指令前缀 / 分块规则）对 **demo-doc.md 的 13 个文本块**做 8 条查询的检索质量对比
（Recall@K / MRR 均由检索排名直接计算，数据见 `eval/out/quality.json`）：

| 精度 | Recall@1 | Recall@3 | MRR | 单条向量化延迟（Node/CPU，中位） |
|---|---:|---:|---:|---:|
| FP32 基线 | 0.750 | 0.875 | 0.844 | 3.9 ms |
| FP16 | 0.750 | 0.875 | 0.844 | 3.8 ms |
| **INT8 (q8)** | **0.750** | **1.000** | **0.854** | **3.2 ms** |

→ 量化后检索质量没有下降（小样本上 INT8 的 Recall@3/MRR 还略高），推理延迟下降。样本量说明：这是 13 块 × 8 查询的演示级评测，
结论用于"量化不明显掉质量"的验收目的，不宣称大规模语料上的绝对水平。

### 3.4 推理后端：WebGPU 优先 + WASM 自动降级

`src/embed.worker.js` 里的选择逻辑：

1. 检测 `navigator.gpu`；存在则显式用 `device: 'webgpu'` + `dtype: 'fp16'` 创建推理管线（题面要求的"优先使用 WebGPU，显式配置对应推理后端"）；
2. WebGPU 初始化/运行失败（驱动、算子不支持等）→ 捕获异常 → 自动降级 `device: 'wasm'` + `dtype: 'q8'`，核心流程不受影响；
3. 当前后端与降级原因回传主线程，页面顶部徽标明确提示：`推理后端：WebGPU · FP16` 或
   `推理后端：WASM · INT8（WebGPU 初始化失败：…）`；
4. 为便于验收两条路径，支持 `?device=wasm` / `?device=webgpu` 强制指定（对应"验证降级路径"要求）。

两条路径均在真实 Chrome（Windows 11 / Chrome 155 / Intel gen-12lp iGPU，支持 WebGPU）中跑通：
默认打开 → `WebGPU · FP16`；`?device=wasm` → `WASM · INT8（按测试参数强制 WASM（用于验证降级路径））`，界面徽标与状态条正确提示。

### 3.5 实测性能（同一台机器、同一语料）

**端侧推理微基准**（Chrome 155，浏览器内，模型已缓存；`eval/out/backend-browser.json`）：

| 配置 | 模型体积 | 单条查询向量化（中位 / 最小） | 16 条批量向量化（中位） | 每条约 |
|---|---:|---:|---:|---:|
| FP32 + WASM（基线） | 90.42 MB | 57.3 / 35.4 ms | 2051 ms | 128.2 ms |
| **FP16 + WebGPU** | 45.23 MB | **15.6 / 11.2 ms** | **65.9 ms** | **4.1 ms** |
| INT8 + WASM（降级路径） | 22.83 MB | 33.2 / 28.7 ms | 1037 ms | 64.8 ms |

**应用内实测**（demo-doc.md 13 个块，同一章程序列：分块 → 批量 16 向量化 → 写 seekdb → 单条 SQL 混合检索）：

| 后端 | 13 块向量化 | seekdb 写入 + 可见性校验 | seekdb 混合检索 | 端到端（含查询向量化） |
|---|---:|---:|---:|---:|
| WebGPU + FP16 | **91 ms（7.0 ms/块）** | 45 ms | 9–23 ms | **31–46 ms** |
| WASM + INT8 | 1197 ms（92.1 ms/块） | 69 ms | 9–21 ms | 51–62 ms |

**加载阶段**（区分首次下载与缓存后）：WebGPU+FP16 首次含 45 MB 权重下载约 7.6 s，缓存后 1.5–2.2 s；
WASM+INT8 缓存后 1.8–3.1 s。加载后先做预热（短文本 + 接近真实查询长度各一次），把 ONNX 会话初始化与首个序列长度的图编译
挪出用户查询路径——只预热短文本时第一条真实查询会卡约 400 ms（已修复）。

## 四、seekdb 承担的部分

### 4.1 表结构与索引

```sql
CREATE TABLE kb_docs (
  id        INT PRIMARY KEY AUTO_INCREMENT,
  doc_id    VARCHAR(255) NOT NULL,   -- 文件名
  chunk_idx INT NOT NULL,            -- 块序号
  title     VARCHAR(255) NOT NULL,
  content   TEXT NOT NULL,           -- 原文
  embedding VECTOR(512),             -- 端侧模型产出的向量
  VECTOR INDEX idx_vec (embedding) WITH (DISTANCE=l2, TYPE=hnsw, LIB=vsag),
  KEY idx_doc (doc_id)
) ORGANIZATION = HEAP;
-- 中文全文检索：ngram 分词
ALTER TABLE kb_docs ADD FULLTEXT INDEX idx_ft (content, title) WITH PARSER ngram;
```

降级链：HNSW 建表失败 → 无向量索引的全表扫描；ngram FULLTEXT 不可用 → 默认分词器 → SQL 内 `LIKE` 计数；
单条 SQL 混合检索异常 → 两路查询 + 应用侧 RRF 兜底（响应里 `hybrid` 字段标注实际路径，正常不会走到）。

### 4.2 混合检索：在 seekdb 内用一条 SQL 完成

`POST /api/search` 的核心 SQL（`server/index.mjs`）：向量路与全文路各自在 SQL 内排名，**RRF 融合也用 SQL 聚合完成**，
Node 侧只做参数替换、结果渲染，不分别取两路结果再自行拼合：

```sql
WITH vec AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY l2_distance(embedding, ?)) AS rnk
  FROM kb_docs ORDER BY l2_distance(embedding, ?) LIMIT 50
),
kw AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY MATCH(content, title) AGAINST (? IN NATURAL LANGUAGE MODE) DESC) AS rnk
  FROM kb_docs WHERE MATCH(content, title) AGAINST (? IN NATURAL LANGUAGE MODE) LIMIT 200
),
fused AS (
  SELECT id, SUM(1.0 / (60 + rnk)) AS score
  FROM (SELECT id, rnk FROM vec UNION ALL SELECT id, rnk FROM kw) u
  GROUP BY id
)
SELECT d.id, d.doc_id, d.chunk_idx, d.title, d.content, f.score,
       l2_distance(d.embedding, ?) AS dist,
       MATCH(d.content, d.title) AGAINST (? IN NATURAL LANGUAGE MODE) AS ft_score
FROM fused f JOIN kb_docs d ON d.id = f.id
ORDER BY f.score DESC LIMIT ?;
```

- 向量距离（`l2_distance`）、全文相关度（`MATCH … AGAINST`）、候选截断、RRF 融合全部在 seekdb 内执行；
- 选用 RRF（k=60）而不是加权求和，无需归一化两路分数量纲；
- 中文全文检索用 `WITH PARSER ngram`，查询词直接交给 `MATCH … AGAINST`（自然语言模式），失败时自动降级默认分词器 / `LIKE`。

### 4.3 增量写入与索引刷新

- 每次导入按 `doc_id` **先删后插**（同一事务）：重复上传同一文件会替换旧块，不会产生重复数据；
- 写入提交后立刻在同一实例内 `SELECT COUNT(*)` 校验**新块已可见**（`/api/ingest` 返回 `visibleChunks`；实测写入 + 校验 45–69 ms）；
- `GET /api/stats` 从 seekdb 读回知识库状态（块数、文件列表、索引模式），页面刷新/进程重启后前台状态与库内一致；
- seekdb 嵌入式实例数据目录持久化（`data/seekdb.db`），重启后知识库仍在（Linux 嵌入式路径已实测重启持久化）。

## 五、性能与质量测试方法

- 固定条件：同一台机器（Windows 11 / Intel iGPU / Chrome 155）、同一语料（`demo-doc.md`，13 块）、同一查询集（8 条）、
  模型版本与精度固定（见 §3.1/3.2）、batch=16、seekdb v1.4.0.0 默认配置。
- 端侧推理：模型加载 / 预热 / 单条查询向量化 / 16 条批量向量化分阶段计时；单条取 15 次的中位数与最小值，批量取 3 轮中位数。
- seekdb：`/api/search` 返回服务端计时（`searchMs`），前端记录查询向量化与端到端延迟；13 块语料规模下重复查询取中位。
- 检索质量：量化前后用同一管线对 demo 语料做检索排名，计算 Recall@1/Recall@3/MRR。
- 原始数据与复现命令见 [`eval/README.md`](./eval/README.md)。

## 六、局限与后续

1. 候选池固定 50（向量路）/ 200（全文路），适合演示规模；上千文档应调大或改 ANN Top-K 直取；
2. 中文全文用 ngram 分词，没有同义词/停用词调优；关键词路在无全文索引的环境下降级 `LIKE`，长句召回弱；
3. 分块为规则切分（标题/段落/句子），未做语义分块；
4. 单条 SQL 混检依赖 seekdb 的窗口函数与 CTE（v1.4.0 实测可用），旧版本会自动走兜底路径；
5. Windows 下 `@oceanbase/seekdb-node@1.4.0` 的嵌入式实例在本机无法启动（`fail to init observer`），
   本地全部实测改用"Windows 前端/后端 + WSL seekdb 服务"的远程模式完成；**Linux 嵌入式路径已单独实测通过**（见 `eval/README.md`），
   判题环境为 Linux 时按 README 默认嵌入式方式即可。
