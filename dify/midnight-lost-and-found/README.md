# 午夜失物招领处

一个由 Dify 编排、PowerContext 保存长期记忆的互动故事。店主阿迟寄存着倒着下雨的伞、通往昨天的车票和总慢半拍的影子。玩家选择失物、支付代价、决定去向。再次来访时，店主会拿出旧收据；开始下一夜也保留此前的交易。

**在线体验：<https://udify.app/chat/1uXn4jV3iOOk1UzB>**。无需进入作者的Dify工作区，输入“开门”开始。运行所需的模型服务须保持有效额度。

已部署的记忆服务为 `https://8.148.13.142/midnight`，采用受信任的IP地址HTTPS证书并自动续期。评审可以直接体验，也可以按照本说明自行部署和导入DSL；无需使用作者的服务密钥。

## 交付与状态

- `midnight-ai-cloud-verified.yml`：**主提交DSL**，Dify Cloud导出，DSL版本0.7.0，包含实际模型插件依赖，不含secret值。导入其他环境需要绑定模型与记忆服务地址。
- `midnight-ai.yml`：主作品，AI 叙事 Chatflow。需要配置一个聊天模型。
- `midnight-rules.yml`：规则试玩 Chatflow，不调用模型，便于排除模型配置对联调的影响。
- `service.py`：可信记忆适配服务，实际调用 PowerContext Scope 和 Memory API。不是进程内字典模拟记忆。
- `game.py`：确定性规则，在 Dify Code 节点执行；后端用同一规则校验提交，避免模型改写账本。
- `build_dsl.py`：从规则源码生成两个 DSL，修改规则后重新运行。
- `test_app.py`：真实 PowerContext 数据库的本地行为验证，以及导出 DSL 的代码节点契约验证。
- `verify_dify.py`：对已发布 Dify 应用执行连续选择、跨会话召回并保存真实运行记录。
- `验收样例.md`：评审可执行的初始条件、步骤、预期表现与重置方法。

本地规则和记忆验证与Dify Cloud运行结果分开记录，见 `验证记录.md`。参赛应用已从主DSL重新导入、配置并发布。云端导出版与生成器兼容版分别保留，不用本地节点执行替代云端结果。服务器配置、资源限制与运维方式见 `部署说明.md`。

## 技术分工

```text
Dify 开始 → 编码身份 → HTTP 读取旧账本 → Code 判断选择
        → LLM 根据确定事件生成叙事（AI版）
        → HTTP 提交新状态 → 确认保存 → Answer 输出故事和选项
                               ↓
                   配套服务 → PowerContext → 持久化 SQLite
```

Dify 承担核心输入处理、规则计算、模型调用、HTTP 编排及输出。PowerContext 是玩家阶段、所选物品、交易代价、历史收据的权威存储；每次请求都从 Memory 读取，服务重启后也能继续。SQLite 是 PowerContext 自身的后端，本作品不另外宣称使用 seekdb。不需要 Embedding、Rerank、知识库或初始数据。

## 环境与依赖

实际验证环境为 **Dify Cloud，DSL 0.7.0**。主提交DSL使用 `langgenius/openai` **1.0.8** 插件和 `gpt-4o-mini`，准确插件标识及哈希保存在DSL的dependencies中。评审可以绑定自己的OpenAI凭据，或在LLM节点选择已授权的其他中文聊天模型。没有Embedding、Rerank或知识库依赖。

`midnight-ai.yml` 和 `midnight-rules.yml` 是生成器输出的DSL 0.4.0辅助文件，用于规则开发和兼容性排查；不能用其源码核对结果代替主DSL的实际云端验证。`build_dsl.py` 不会改写主提交DSL。

配套服务：Python 3.12，PowerContext 官方提交 `9db1753434162c0aa7c9f1189a1722e617880a52`（包版本 1.2.0），其他直接依赖见 `requirements.txt`，本机验证的完整依赖见 `requirements-lock.txt`。固定源码依赖需要 Git 和可访问 GitHub 的网络。

Linux服务器使用Python 3.14独立虚拟环境。服务由 `deploy/midnight-memory.service` 单进程托管，内存上限384MB、CPU上限50%；系统服务读取root-only配置文件 `/etc/midnight-memory.env`，数据存放在 `/var/lib/midnight-memory`。源码与虚拟环境位于 `/srv/midnight`，不依赖作者电脑上的数据。

## 1. 安装和启动记忆服务

在本目录打开 PowerShell：

```powershell
uv venv .venv
uv pip install --python .venv/Scripts/python.exe -r requirements-lock.txt
$env:MIDNIGHT_TOKEN = python -c "import secrets; print(secrets.token_urlsafe(32))"
$env:MIDNIGHT_DATA = "$PWD/data"
.venv/Scripts/python.exe -m uvicorn service:create_app --factory --host 0.0.0.0 --port 8765 --workers 1
```

保留服务进程。将生成的 `MIDNIGHT_TOKEN` 通过自己的本地配置保存，并在 Dify 的 secret 环境变量 `memory_token` 中填入同一个值；不要写入 DSL、源码或提交记录。重启服务仍需设置该变量。`/health` 是不含数据的健康检查入口。

Linux/macOS 使用 `.venv/bin/python` 并通过 `export` 设置同名环境变量。也可自行生成 `.env` 后执行 `docker compose --env-file .env up -d --build`；Compose 默认为宿主回环端口。容器部署文件已提供，是否实际构建应看验证记录。

服务不需要人工初始化数据；第一次访问时创建玩家 Scope。运行目录应具备写权限并持久保存 `runtime.db`、`scheduler.db`。只支持单 worker，不应启动多个写入进程共享数据目录。

## 2. 配置 Dify 网络

`memory_url` 必须是 **Dify 服务端及其 HTTP 请求代理能访问的地址**：

- Dify 在本机 Docker Desktop，服务原生运行在 Windows：尝试 `http://host.docker.internal:8765`，并确认防火墙、HTTP 请求代理允许该目标。
- 两个服务在同一 Docker 网络：使用记忆服务容器的 DNS 名称 `http://midnight-memory:8765`；需把服务连接到实际 Dify HTTP 代理能够到达的网络。独立运行本目录 Compose 不会自动加入已有 Dify 网络。
- Dify 在远程主机或云端：本机 `localhost` 和 `host.docker.internal` 都不能代表你的电脑。应将配套服务部署到其可达的可信服务器，通过受控网络或 HTTPS 反向代理提供访问。

不要全局关闭 Dify 的 SSRF 防护；按部署策略允许这个具体服务目标。Bearer token 仅授予 Dify 服务端，不能暴露给浏览器、终端用户或模型。配套服务是受信任的 Dify 内部接口，不是公开多租户用户认证系统。

## 3. 导入及配置

1. 在Dify工作室选择“导入DSL”，导入 **`midnight-ai-cloud-verified.yml`** 即可。其他DSL为独立辅助应用，无需先导入或运行。
   也可以选URL导入 `https://8.148.13.142/midnight/dsl.yml`；该地址只提供不含secret值的主DSL，与仓库文件一致。
2. 在环境变量中设置 `memory_url` 和 secret 类型的 `memory_token`。URL 末尾不要加 `/`。
3. 检查“读取 PowerContext 旧账本”和“将选择写入 PowerContext”两个 HTTP 节点。地址、Authorization 和 JSON 请求体均来自环境变量/前序代码节点，无需手工填写用户输入。
4. 预览中执行 `开门 → 1 → 3 → 1`。应完成一次“伞 / 一个冷笑话 / 归还失主”的交易。
5. 在“阿迟讲述这一夜”LLM节点绑定模型凭据。不要给LLM写入记忆服务密钥。模型只润色故事，固定选项与状态由规则决定。
6. 执行验收样例，检查叙事遵守物品、代价、去向。发布后体验入口是Dify生成的WebApp或应用API。

Code 节点不访问网络、不安装第三方包。由 Dify 的内置 sandbox 执行标准库代码。需要确认 Dify 的 sandbox 正常运行。

## 4. 身份与跨会话记忆

工作流使用受信任的 `sys.user_id`，不从玩家发言提取身份。后端将其哈希为 Scope 的幂等键。同一身份的新会话复用旧账本，不同身份互相隔离。

调用 Dify API 时，必须为同一玩家持续传相同的 `user`。网页端用户身份由 Dify 维护，清理浏览器数据、换浏览器或重新导入应用可能产生新身份。跨会话验收优先使用随附 API 脚本，不把网页昵称相同当作身份相同。

`重新开局` 只推进到下一夜并保留最多12笔收据。完全干净的验证用一个新的 API `user`；不需要删除别人的存档。单个身份最多允许120次有效状态变更，达到上限后用新身份开始；这是演示规模限制。每次读取的历史数量有上限，没有声称支持无限长期游玩。

## 5. 验证和运行证据

```powershell
.venv/Scripts/python.exe build_dsl.py
.venv/Scripts/python.exe -m pytest -q test_app.py --basetemp=.test-tmp-manual
$env:DIFY_APP_KEY = '在当前终端设置自己的应用 API Key'
.venv/Scripts/python.exe verify_dify.py --base-url 'https://你的Dify地址/v1'
```

脚本会用一个全新用户执行完整交易，再省略 conversation_id 创建新会话，检查是否提到之前的伞。输出存入 `evidence/local-dify-run.json`，不包含应用 Key。AI 叙事是开放输出，还需人工检查是否遵守交易事实；脚本的关键词检查不能替代这一点。

异常路径：未授权请求返回401；伪造或不符合规则的状态返回422；旧修订提交返回409。只有写入成功才展示本轮结果。重复的当前交易提交返回原修订，不重复记账。一个身份建议只在一个窗口操作；并发提交失败后重新发送选择。自由发言可以触发 AI 接话，但不会直接获得物品或改变交易阶段。

## 提交与来源

本目录位于官方生态基线分支后代 `codex/dify-midnight` 的 `dify/` 下。生态基线：`d647275c308e09b7b623f322a26f5c4e85734fb0`。记忆 SDK 的基线与交付仓库的生态基线是两个不同用途的版本。

平台提交使用报名登记的本队仓库、交付分支及完整commit SHA；实际提测状态见提交记录。公开部署入口和验证证据均不等于平台评测通过。

玩法、DSL和适配代码为本作品原创；PowerContext 与 Dify 为使用的开源组件。未复用其他队伍或第三方游戏 DSL。

- [官方赛题](https://oceanbase.yuque.com/org-wiki-obtech-vh7w9r/hc3pio/lhfslihtnnb8yqh6)，核对于2026-10-26。
- [官方生态基线](https://github.com/oceanbase/powercontext/tree/2026-competition-ecosystem)。
- [PowerContext 源码基线](https://github.com/oceanbase/powercontext/tree/9db1753434162c0aa7c9f1189a1722e617880a52)。
- [Dify 1.9.1 DSL 导入实现](https://github.com/langgenius/dify/blob/1.9.1/api/services/app_dsl_service.py)。
- [Dify HTTP Request 文档](https://docs.dify.ai/en/cloud/use-dify/nodes/http-request)。
