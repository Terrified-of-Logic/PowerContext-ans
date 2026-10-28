# 规有所依 · SDD 上下文管理系统

面向软件持续演进的工程上下文模块：**给定一个开发任务，自动找出适用的规格条目、
需要修改的代码符号、用于验证的测试，组装成开发上下文交给 MiniMax 完成代码修改，
并把任务进展与验证结果存入 PowerContext，重启后可以读回。**

## 一、它解决什么问题

AI 开发助手改代码时，需要知道三件事：**当前应遵守什么要求**、**该改哪些代码**、**怎么验证**。
这些信息散落在规格文档、源码和测试里，人工整理容易遗漏，规格变了还可能拿着过期信息去改。

本模块把这三类资料索引进 seekdb，按任务检索出当前**有效**的部分，并连同任务进展一起交给助手。

## 二、技术分工

| 技术 | 在流程中的作用 | 用到的能力 |
|---|---|---|
| **MiniMax** | 参与本次任务的代码生成与修改 | `/v1/text/chatcompletion_v2` 对话补全 |
| **seekdb** | 存储工程资料（规格 / 代码 / 测试），检索结果用于构造任务上下文 | 嵌入式实例、MySQL 协议、`INSERT` / `SELECT` / `TRUNCATE` |
| **PowerContext** | 保存任务进展与验证结果，后续运行读取复用 | `POST /v1/memory/remember`、`POST /v1/memory/entries/list` |

## 三、依赖版本

| 组件 | 版本 | 说明 |
|---|---|---|
| **Node.js** | **≥ 22** | `@oceanbase/seekdb-node` 要求 `node>=22`，请先 `node -v` 确认 |
| `@oceanbase/seekdb-node` | 1.4.x | seekdb 嵌入式实例，自带各平台原生包，`npm install` 自动装 |
| `mysql2` | 3.x | 连接 seekdb |
| **PowerContext** | **1.4.1** | 独立服务，需先安装并启动（见下） |
| MiniMax API | `MiniMax-Text-01` | 需要 API Key |

## 四、配置步骤

### 1. 安装依赖

```bash
cd minimax
npm install
```

> 若 `@oceanbase/seekdb-node` 的原生包未随 `npm install` 装好，可加 `--include=optional` 重装。

### 2. 安装并启动 PowerContext

```bash
# 安装 CLI（只需一次）
pip install uv
uv tool install --force "powercontext[cli,server]==1.4.1"

# 生成配置（免模型模板，不需要推理 API）
powercontext config init --template -o ../powercontext/.env

# 启动服务，监听 http://127.0.0.1:8000
powercontext server run --env-file ../powercontext/.env
```

说明：

- 若 `powercontext` 命令不在 PATH，可用 `uv tool run powercontext ...`，或在
  `~/.local/bin/`（Windows 为 `%USERPROFILE%\.local\bin\`）下找到可执行文件直接用
- 配置使用 SQLite 落盘，不需要额外数据库
- **未配置推理模型**，只使用显式记忆写入，不需要任何模型 Key
- 服务启动后出现 `PowerContext Server is ready` 即成功

> 若 PowerContext 未启动，上下文模块与 Agent 仍可运行，只是「任务当前状态」一节会显示不可用提示。
> 但**验收项「状态能够复用」需要它处于运行状态**。

### 3. 设置 MiniMax 凭据

```bash
# Windows PowerShell
$env:MINIMAX_API_KEY = "你的 Key"

# macOS / Linux
export MINIMAX_API_KEY="你的 Key"
```

可选：`MINIMAX_MODEL`（默认 `MiniMax-Text-01`）、`MINIMAX_BASE_URL`（默认 `https://api.minimaxi.com/v1`）。

## 五、调用入口

**以下命令都可以从任意目录执行**（脚本按自身位置定位工程，不依赖 `cd`）。

```bash
# 1) 把工程资料索引进 seekdb
node context/cli.mjs ingest

# 2) 按任务生成上下文（输出 Markdown）
node context/cli.mjs context --task "实现按状态过滤：只返回指定状态的订单"

# 3) 上下文输出为 JSON（便于程序消费）
node context/cli.mjs context --task "实现按状态过滤" --json --out context.json

# 4) 查看库内条目
node context/cli.mjs stats

# 5) 保存 / 读回任务状态
node context/cli.mjs status --set "任务 T1：已完成上下文检索，待办：修改 queryOrders"
node context/cli.mjs status

# 6) 完整流程：检索 → MiniMax 改代码 → 跑测试 → 记录状态
node agent/run.mjs --task "实现按状态过滤：只返回指定状态的订单"
```

`node agent/run.mjs --dry-run` 只生成上下文与提示词，不调用模型、不改文件。

## 六、测试命令

```bash
# 业务工程的测试（11 条用例）
node business/test/orders.test.js
```

修改前应有 **2 条失败、9 条通过**（失败的是尚未实现的 R1 目标功能）；
修改后应 **11 条全部通过**，退出码 0。

## 七、目录结构

```
minimax/
├── business/                业务工程（被改造对象）
│   ├── specs/orders.md      规格：需求的唯一依据
│   ├── src/orders.js        业务代码（R1 未实现）
│   └── test/orders.test.js  测试：11 条，含目标功能与回归
├── context/                 上下文模块
│   ├── cli.mjs              调用入口（ingest / context / status / stats）
│   ├── ingest.mjs           资料切分（规格按标题、代码按文件、测试按用例）
│   ├── retrieve.mjs         检索打分与上下文组装
│   ├── store.mjs            seekdb 存取
│   └── powercontext.mjs     PowerContext 客户端
├── agent/                   开发助手接入
│   ├── run.mjs              完整流程驱动
│   ├── minimax.mjs          MiniMax 调用封装
│   └── runs/                每次运行的过程记录
└── docs/                    交付文档
    ├── 验证样例.md           任务描述、有效规格、操作步骤、预期结果、重置方法
    ├── 代码与测试.md         修改前后快照、代码差异、新增功能测试、回归测试、运行日志
    ├── 技术使用记录.md       MiniMax 开发记录、seekdb 查询记录、PowerContext 记录
    └── 技术说明.md           模块结构、上下文选择方式、各项技术分工
```

## 八、已知限制

- 检索是**关键词 + 结构**打分，未使用向量检索。语料规模在百条量级时足够准确，
  上万条时应换成向量索引（seekdb 支持 `VECTOR` 列与 HNSW 索引）。
- 只支持 `.md` / `.js` 两类资料；其他语言需要补切分规则。
- MiniMax 返回的是整文件替换，不做增量补丁合并；模型输出不可用时需人工介入。
- PowerContext 未配置推理模型，因此只做**显式记忆写入**，不做自动抽取。
