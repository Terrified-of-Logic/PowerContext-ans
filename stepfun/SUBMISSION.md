# StepFun 提交材料索引（机器可读结果 + 证据）

本目录是「阶跃星辰 · 端侧 AI 推理性能优化与 seekdb 混合检索」的完整提交材料。为方便判题，机器可读结果放在本目录根部：

| 文件 | 说明 |
|---|---|
| `submission-results.json` | 提交结果总表：验收项逐条状态 + 证据路径 + 功能测试运行记录 + 量化/性能摘要 |
| `compliance-results.json` | 合规自检：本地推理、无云端 API、无服务端预计算/回放、seekdb 存储与检索、混合检索在库内完成等 |
| `performance-results.json` | 性能实测：固定测试条件、三行对比表（FP32 基线 / FP16+WebGPU / INT8+WASM）、分阶段计时、优化前后对比 |
| `README.md` | 运行与验收步骤（环境、启动、界面自检、接口） |
| `TECH_REPORT.md` | 一页技术说明（模型/量化、端侧运行与降级、seekdb 用法、状态与优化、实测数据） |
| `eval/` | 全部原始数据、复现脚本说明、截图、浏览器探针、Linux 嵌入式验证记录 |
| `eval/out/*.json` | 原始测量数据（`quality.json` 量化质量 / `backend-browser.json` 后端性能 / `e2e-api.json` 全链路） |

## 快速验证（约 3 分钟）

```bash
cd stepfun
npm install
npm start                      # 后端 8787（seekdb 嵌入式）+ 前端 5173
# 浏览器打开 http://localhost:5173/：
#   1) 顶部徽标显示「推理后端：WebGPU · FP16」（无 WebGPU 环境显示 WASM · INT8 + 原因）
#   2) 把 demo-doc.md 拖进页面 → 状态条显示端侧向量化/seekdb 写入耗时
#   3) 输入「向量索引怎么建」检索 → 展示 RRF 排序结果与各阶段耗时
curl http://127.0.0.1:8787/api/health   # 返回 vectorIndex=hnsw / keyword=fulltext-ngram / hybrid=single-sql
```

一键复现测量数据：

```bash
npm run eval:quality    # 量化前后质量对比（FP32/FP16/INT8）
npm run eval:e2e        # 端到端：端侧模型 → /api/ingest → /api/search
npm run eval:sql        # seekdb SQL 兼容性自检（DDL/索引/单条 SQL 混合检索/增量替换）
```

## 关键实测（详见 performance-results.json）

- 模型体积：FP32 **90.42 MB** → FP16 **45.23 MB**（2.00×）→ INT8 **22.83 MB**（3.96×）
- 检索质量（13 块 × 8 查询）：Recall@1 0.75 / 0.75 / 0.75；Recall@3 0.875 / 0.875 / 1.000；MRR 0.844 / 0.844 / 0.854
- 浏览器向量化（缓存后，中位）：FP16+WebGPU 单条 **15.6 ms**、16 条批量 **65.9 ms**；INT8+WASM 33.2 ms / 1037 ms
- 应用内 13 块导入：WebGPU **91 ms**（7.0 ms/块） vs WASM 1197 ms
- seekdb 单条 SQL 混合检索（13 块语料）：**9–23 ms**；端到端查询 **31–46 ms**（WebGPU）/ **51–62 ms**（WASM）
- Linux 嵌入式 seekdb：4–5 秒就绪，写入/检索/重启持久化全部通过（`eval/linux-embedded.md`）

## 架构一句话

浏览器 Web Worker 用 Transformers.js + ONNX Runtime Web 在本地算 512 维向量（WebGPU+FP16 优先，WASM+INT8 自动降级并在界面提示）；
向量、原文、元数据写入 seekdb（`VECTOR(512)` + HNSW + FULLTEXT ngram）；检索时**一条 SQL** 同时完成向量路 + 全文路排名与 RRF 融合，
Node 侧只做参数替换和渲染，不把两路结果拉回客户端拼合。
