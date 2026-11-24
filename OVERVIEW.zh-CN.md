统一管理每台 Paseo 主机上保存的 Claude Code、Codex 与 Antigravity 原生历史会话，包括在 Paseo 之外通过终端启动的会话。支持跨引擎按工作目录统一分组，在全部、Claude Code、Codex 和 Antigravity 视图之间切换，全文搜索标题、提问、回复、路径与会话 ID，检视元数据与磁盘文件清单，一键复制各引擎的原生恢复命令，并将不需要的会话安全移入主机回收站以供恢复或永久删除。

插件会自动扫描目标主机上已配置的各引擎数据目录：
- Claude Code：`CLAUDE_CONFIG_DIR`、`~/.claude` 以及 Paseo Provider 配置目录。
- Codex：`CODEX_HOME`、`~/.codex` 以及 Paseo Provider 配置目录。
- Antigravity：`ANTIGRAVITY_DATA_DIR`、`ANTIGRAVITY_CLI_DIR`、`~/.gemini/antigravity-cli`、`~/.gemini/antigravity` 以及 Paseo Provider 配置目录。

每台主机独立扫描并维护各自的回收站（位于 `$PASEO_HOME/plugin-data/session-manager/trash/`），可通过 Paseo 主机选择器切换主机。所有数据仅保留在对应主机与已连接的 Paseo 客户端之间。

删除操作仅移动白名单内的会话专属文件：Claude 会话记录、子目录、旧版子 Agent 与按 ID 存放的文件；Codex Rollout 记录、能力标记与 Shell 快照；Antigravity 对话数据库、Brain 目录、批注与锁文件。设置、登录凭据、提问历史、Skills、插件、MCP 配置、共享数据库、项目记忆和项目源码绝不会被改动。正被活跃 Claude Code 进程、打开中的 Antigravity WAL 数据库或运行中的 Paseo Agent 使用，或最近 90 秒内有写入的会话无法删除。

需要 Paseo 0.13.0 或更高版本。界面支持英文和简体中文，跟随客户端语言设置。安装与开发说明请参阅仓库 README。
