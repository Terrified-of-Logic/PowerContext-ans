# Dify 参赛交付：午夜失物招领处

作品使用Dify编排互动剧情，通过PowerContext持久保存交易和跨对话记忆。

- 主DSL：[`midnight-lost-and-found/midnight-ai-cloud-verified.yml`](midnight-lost-and-found/midnight-ai-cloud-verified.yml)，Dify Cloud导出，DSL 0.7.0。
- 安装、配置、初始化及入口：[`midnight-lost-and-found/README.md`](midnight-lost-and-found/README.md)。
- 完整玩法验证：[`midnight-lost-and-found/验收样例.md`](midnight-lost-and-found/验收样例.md)。
- 实际运行结果和截图：[`midnight-lost-and-found/验证记录.md`](midnight-lost-and-found/验证记录.md)及其 `evidence/`。
- 配套服务源码、锁定依赖、Docker与systemd部署材料均位于同一目录。

主DSL不包含secret值。评审可自行启动配套服务，设置两个环境变量并绑定可用聊天模型。没有预置数据依赖，新的API user即为新玩家；不要求依赖作者原有的浏览器会话或数据库状态。
