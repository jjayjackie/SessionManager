# Claude 会话管理器

[English](./README.md)

一个 [Paseo](https://paseo.sh) 插件，用于在每台 Paseo 主机上管理 **Claude Code 原生历史会话**：浏览、搜索、查看详情、复制恢复命令、删除到回收站、恢复和永久清除。插件直接读取 `~/.claude/projects/`（以及其他 Claude 配置目录），因此终端、IDE 或 Paseo 启动的会话都能管理。

基于 panrafal 的 [`session-usage`](https://github.com/panrafal/paseo-plugins/tree/main/session-usage)（MIT）二次开发：Claude 目录发现与 Paseo Agent 记录读取逻辑改编自上游，扫描器、删除引擎、回收站和界面为新实现。

## 功能

- **覆盖主机上的所有 Claude 目录**：`$CLAUDE_CONFIG_DIR`、`~/.claude`，以及 Paseo 中设置了 `CLAUDE_CONFIG_DIR` 的 Provider 配置（多账号），按物理路径去重。
- **按项目分组导航**，显示记录的工作目录，计数随搜索结果变化。
- **全文搜索**标题、提问和 Claude 回复（多个词同时匹配），也匹配会话 ID、路径和分支，并显示命中片段。
- **筛选与排序**：状态（使用中/空闲）、完整性（正常/损坏/空）、来源（Paseo/原生），按最近活动、开始时间、大小、消息数或标题排序，支持分页。
- **会话详情**：标题来源、工作目录、分支、时间、消息数、大小、Claude Code 版本、模型、删除时将移动的文件、重复会话 ID、恢复或分叉产生的副本（共享消息 UUID）、对话预览。
- **Resume 命令**：正确的 Shell 转义，自动 `cd` 到记录目录，非默认目录附带 `CLAUDE_CONFIG_DIR=`，一键复制。
- **单条与批量删除**：主机侧预览、确认对话框、逐条结果反馈。
- **独立回收站**：恢复（每个会话全部恢复或不恢复）、永久删除所选、清空回收站，均需确认。
- **Paseo 原生体验**：带主机选择器的页面、侧边栏入口、命令中心入口，使用主题色适配深浅色，三栏/两栏/单栏响应式布局，Paseo 弹窗（手机上为底部抽屉）、Toast 和剪贴板。
- **简体中文与英文**，跟随 Paseo 客户端语言，其他语言回退英文。

## 安装

需要守护进程和客户端均为 **Paseo 0.13.0 或更高版本**，并在 **设置 → 插件** 中启用插件。

在需要管理会话的每台主机上安装（插件运行在该主机的守护进程上）：

```bash
paseo plugin add git:jjayjackie/paseo-plugins:claude-session-manager
# 指定版本或分支
paseo plugin add git:jjayjackie/paseo-plugins:claude-session-manager --ref claude-session-manager-v0.1.0
# 远程守护进程
paseo --host <url> plugin add git:jjayjackie/paseo-plugins:claude-session-manager
```

也可以从 [Releases](https://github.com/jjayjackie/paseo-plugins/releases) 下载 `claude-session-manager-<版本>.tar.gz`，在守护进程所在机器解压后执行 `paseo plugin install /绝对路径/claude-session-manager`，或在 **设置 → 插件 → 插件来源** 中粘贴上述来源。

插件没有运行时依赖。用 `paseo plugin ls` 确认状态为 `running`，然后在侧边栏或命令中心（⌘K / Ctrl+K）打开 **Claude 会话**。

## 删除会改动什么

删除只会把以下内容移入回收站：

| 位置（Claude 目录内） | 条件 |
| --- | --- |
| `projects/<目录>/<id>.jsonl` | 始终（`/resume` 列出的会话记录） |
| `projects/<目录>/<id>/` | 存在时（子 Agent 记录、工具结果） |
| `sessionId` 为 `<id>` 的 `projects/<目录>/agent-*.jsonl` | 旧版子 Agent 格式 |
| `todos/<id>.json`、`todos/<id>-agent-*.json`、`file-history/<id>/`、`session-env/<id>/`、`debug/<id>.txt`、`tasks/<id>/` | 仅当同一目录下没有其他记录使用相同会话 ID 时 |

若存在 `projects/<目录>/sessions-index.json`（部分 Claude Code 版本的 `/resume` 摘要缓存），会删除其中对应条目并在恢复时放回；未知字段保持不变，无法解析的索引不会被改动。

**绝不改动**：`settings*.json`、`.credentials.json`、`~/.claude.json`、`history.jsonl`（所有会话共享且被并发追加的提问历史）、`CLAUDE.md`、`skills/`、`plugins/`、`agents/`、`commands/`、MCP 配置、`projects/<目录>/memory/`，以及 Claude 目录之外的任何内容（包括项目源码）。

回收站位于同一主机的 `$PASEO_HOME/plugin-data/claude-session-manager/trash/`（权限 `0700`）。

## 安全机制

- 所有文件操作只在主机守护进程侧执行；客户端只发送不透明的会话键，不会传入任何路径。
- 固定白名单：路径必须位于受管的顶层目录（`projects`、`todos`、`file-history`、`session-env`、`debug`、`tasks`）内，不跟随、不移动符号链接（顶层目录本身为链接的情况受支持）。
- 保护运行中的会话：Claude Code 进程注册表（`<配置目录>/sessions/<pid>.json`）中进程存活、绑定的 Paseo Agent 正在运行，或最近 90 秒内有写入时拒绝删除。
- 预览指纹：确认删除时提交预览的文件指纹，中途有变化（会话被恢复、被其他客户端删除）则跳过。
- 每台主机同一时间只执行一个修改操作，避免多客户端并发交错。
- 移动具备事务性：中途失败会回滚；恢复先检查所有目标且从不覆盖；被篡改的清单无法写到 Claude 目录之外。
- 重复会话 ID 分别列出，共享文件保留到最后一份删除；共享消息 UUID 的恢复/分叉副本显示为相关会话，删除其一不影响其他。
- 损坏的 JSONL 会被标记和计数，仍可查看、删除和恢复。
- 搜索文本只保存在内存中，不写入磁盘，会话记录消失后即释放。

## 远程主机

Paseo 按守护进程安装插件。插件安装在多台主机上时，页面标题栏显示 Paseo 主机选择器；扫描、读取、删除和恢复都通过官方插件 RPC 在所选主机执行，各主机拥有独立的目录、缓存和回收站。切换主机时界面重新挂载，查询键包含主机 ID；主机离线时显示最后数据和提示，绝不回退到其他主机；重连后自动刷新。插件不会额外开启服务或端口。

## SDK 能力说明

全部使用公开的 Paseo 插件 SDK。SDK 未提供的能力及兼容方案：

- 没有日期本地化 API：使用 `Intl.DateTimeFormat` / `Intl.RelativeTimeFormat` 配合 `useTranslation` 返回的语言。
- 没有复选框、下拉选择、徽标组件：用 React Native 基础组件实现，颜色只取自 `theme.colors`，下拉使用 Paseo `Modal`。
- 无法按 Claude 会话 ID 查询 Agent 实时状态：结合 Claude Code 进程注册表与磁盘上的 Paseo Agent 记录（与上游 `session-usage` 一致），并以 90 秒写入窗口兜底。
- 插件 RPC 不支持跨主机调用：依赖 Paseo 主机选择器，需在每台主机分别安装。
- `useSubscription` 仅 Paseo 0.16 起提供：为兼容 0.13 采用轮询（30 秒，首次扫描时 1.5 秒）。

## 开发与 CI

本地不进行任何编译、构建、测试或依赖安装。所有步骤（边界与安全审计、类型检查、ESLint、使用模拟会话的测试、esbuild 打包检查、依赖审计、CodeQL、打包）均在 GitHub 托管 Runner 上运行。推送标签 `claude-session-manager-v<版本>` 会发布 GitHub Release（含压缩包和 `SHA256SUMS.txt`）。

**无法在 CI 中自动验证、需人工验证的项目**：Paseo 客户端在桌面/Web/iOS/Android 及深浅色主题下的显示；多主机切换、主机离线与重连；运行中切换中英文；真实 Claude Code 中 `/resume` 在删除后不再显示、恢复后重新显示；真实进程注册表与 Paseo Agent 的运行检测。

## 限制

- 仅管理 Claude Code 会话。
- `history.jsonl`（上箭头提问历史）按设计保留已删除会话的提问。
- 回收站不会自动过期，请在回收站页清空。
- 全文搜索每个会话最多索引 256 KB 的提问和回复，不索引工具输出。

## 许可证

MIT，见 [LICENSE](./LICENSE)。原始作品 © panrafal；本插件 © jjayjackie。
