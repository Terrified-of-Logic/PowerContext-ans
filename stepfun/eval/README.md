# 评测与复现（原始数据 + 脚本）

本目录保存提交材料里所有实测数据的**原始输出**和复现方式。数据均来自提交代码的实际运行，非理论估值。

## 一、环境

| 项 | 值 |
|---|---|
| 机器 | Windows 11，Intel gen-12lp 核显（WebGPU adapter，支持 `shader-f16`） |
| 浏览器 | Chrome 155.0.0.0（`navigator.gpu` 存在，WebGPU 可用） |
| Node | v24.17.0（Windows）/ v22.20.0（WSL Linux 嵌入式验证） |
| seekdb | `5.7.25-OceanBase seekdb-v1.4.0.0`（@oceanbase/seekdb-node 1.4.0；嵌入式 + WSL 服务两种跑法） |
| 模型 | `onnx-community/bge-small-zh-v1.5-ONNX`（ModelScope 镜像，revision `5b414c2c2d177d066e7bdc32b6ad2a4518a59333`） |
| 语料 | `demo-doc.md`（13 个文本块）+ 8 条查询 |

## 二、数据文件

| 文件 | 内容 |
|---|---|
| `out/quality.json` | 量化前后检索质量：FP32 / FP16 / INT8 在 13 块语料 × 8 查询上的排名、Recall@1/3、MRR、单条向量化延迟 |
| `out/backend-browser.json` | 浏览器内三种配置（FP32+WASM / FP16+WebGPU / INT8+WASM）的加载、单条、批量向量化耗时；应用内 13 块导入与检索端到端读数 |
| `out/e2e-api.json` | 服务端全链路冒烟：本地（Node）向量化 → `/api/ingest` → `/api/search` 的命中排名、seekdb 服务端耗时、单条 SQL 混合检索路径 |
| `screenshots/webgpu-fp16.png` | 应用在 WebGPU+FP16 下的界面（后端徽标、知识库状态、检索结果与耗时） |
| `screenshots/wasm-fallback.png` | `?device=wasm` 强制降级路径的界面（WASM+INT8 + 降级原因提示） |
| `backend-probe.html` | 浏览器后端微基准页（复现 `backend-browser.json` 的 results 部分） |
| `gpu-probe.html` | WebGPU 可用性/适配器信息探针 |

## 三、复现命令

先安装依赖并启动 seekdb（两种方式任选）：

```bash
npm install

# 方式 A：嵌入式（Linux / macOS）
npm run server          # seekdb 嵌入式实例跑在 3000 行 Node 进程内，数据在 ./data/seekdb.db

# 方式 B：远程模式（Windows 下嵌入式实例在本机不可用时的替代；或连接已有 seekdb）
SEEKDB_REMOTE=1 SEEKDB_HOST=127.0.0.1 SEEKDB_PORT=2882 SEEKDB_USER=root SEEKDB_PASSWORD= SEEKDB_DB=test \
  node server/index.mjs
```

1. **量化质量对比**（Node + onnxruntime，自动下载三套权重到 `.cache/`）：

   ```bash
   npm run eval:quality              # = node scripts/eval-quality.mjs fp32 q8 fp16
   ```

2. **浏览器后端微基准**：用 Chrome 打开 `eval/backend-probe.html`（需联网加载模型；控制台/页面会输出 `RESULTS_JSON`）。

3. **全链路（向量化 → seekdb 写入 → 单条 SQL 混合检索）**：

   ```bash
   npm run eval:e2e                  # = node scripts/smoke-api.mjs http://127.0.0.1:8787 3
   ```

4. **seekdb SQL 兼容性自检**（DDL、HNSW、FULLTEXT ngram、单条 SQL 混合检索、增量替换）：

   ```bash
   SEEKDB_HOST=127.0.0.1 SEEKDB_PORT=2882 npm run eval:sql
   ```

5. **降级路径验证**：页面地址加 `?device=wasm` 强制 WASM+INT8，界面徽标/状态条应显示降级原因；
   不加参数时默认尝试 WebGPU+FP16。

6. **Linux 嵌入式验证（WSL）**：见 `linux-embedded.md`。

## 四、关键结论（与 `TECH_REPORT.md` 对应）

- 模型体积：FP32 90.42 MB → FP16 45.23 MB（2.00×）→ INT8 22.83 MB（3.96×）。
- 检索质量（13 块 × 8 查询）：Recall@1 0.750 → 0.750 → 0.750；Recall@3 0.875 → 0.875 → 1.000；MRR 0.844 → 0.844 → 0.854。
- 向量化（浏览器，缓存后）：FP16+WebGPU 单条中位 15.6 ms / 16 条批量 65.9 ms；INT8+WASM 33.2 ms / 1037 ms；FP32+WASM 57.3 ms / 2051 ms。
- 应用内 13 块导入：WebGPU 91 ms（7.0 ms/块），WASM 1197 ms（92.1 ms/块）。
- seekdb 单条 SQL 混合检索：9–23 ms（13 块语料）；端到端查询（含端侧查询向量化）31–62 ms。
