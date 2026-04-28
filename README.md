# QQBot

> 这份 README 写给来逛仓库的人。如果你是 AI 代理（Claude Code、Cursor 之类），请直接看 [`CLAUDE.md`](./CLAUDE.md) 的索引，不要把这份 README 当工作面文档。

一个**只响应命令**的 QQ 个人小机器人。它本身不实现 QQ 协议，而是作为 [NapCatQQ](https://github.com/NapNeko/NapCatQQ) 的反向 WebSocket 客户端跑在你电脑/服务器上，把 OneBot 11 协议的消息事件解析、路由、再分发给 `src/commands/` 下的单文件处理器（handler）。

普通聊天它一律不响应——没有"在吗"，没有"哈哈"，没有任何 fallback。它只在以下两种情况开口：

- **私聊**：消息以 `/` 开头（前缀可改）。
- **群聊**：你拉它进了白名单群，并且消息 `@bot /xxx`。

任何其它输入会被悄无声息地丢掉（debug 日志会记一笔，info 不会）。这是有意为之的——避免误触、避免被群友当聊天机器人玩、保护账号安全。

## 它能做什么

- 路由 `/<cmd>` 命令到对应的 handler。新增命令 = 在 `src/commands/` 加一个 `.ts` 文件，runtime 自动热加载，**不需要重启进程**。
- 多账号能力靠你跑多个 NapCat 实例 + 多个 QQBot 实例，本项目本身只对应一个 QQ 号。
- 内置一层 OpenAI 兼容的 LLM 调用客户端（`ctx.llm.chat(...)`），任何 handler 都可以调用——但用户不会跟 LLM 直接对话，所有 LLM 能力必须以"具体命令"的形式包装出来（比如下面的 `/translate`）。
- 配置（白名单、限流、前缀、LLM provider 等）写在单一一份 `config/bot.json5` 里，大部分字段改完保存即时生效。

## 已自带的命令

- `/help` — 列出所有已注册命令。
- `/translate <文本>` — 把文本翻译成中文，调用配置的 LLM。
- `/translate`（同时附带图片） — 把图片里的外文文字翻译成中文，需要支持视觉的 LLM 模型。也支持 `/translate <文本>` + 图片同时给。

## 不打算做的

下面这些是**有意识的边界**，不是没空做。如果你想加，先想清楚是不是真的需要：

- ❌ 主动推送、定时任务、订阅类命令（机器人是被动的）
- ❌ 数据库、持久化的命令状态（命令默认无状态）
- ❌ 多账号、多实例（一个进程对一个号）
- ❌ Web UI、远程管理面板
- ❌ 富媒体上行（OCR、语音转文字等）—— 真要做，让 handler 自己用 LLM 多模态实现
- ❌ 用户与 LLM 直接对话（所谓 `/ask` `/chat` 这类自由对话命令）。LLM 必须包在有界的工具命令里。

## 怎么开始

详细安装、NapCat 接入、首跑、排错，看 [`QUICKSTART.md`](./QUICKSTART.md)（中文，比这里详尽得多）。

最最简短版：

```bash
pnpm install
$EDITOR config/bot.json5     # 至少改 listen.token、selfId、allowedGroups
pnpm dev                      # tsx watch 起 bot
pnpm smoke                    # 跑 13 项验收用例，应当全过
```

## 项目结构（鸟瞰）

```
QQBot/
├── README.md            ← 本文件，项目简介
├── QUICKSTART.md        ← 上手手册（详细操作步骤）
├── CLAUDE.md            ← 给 AI 代理用的索引
├── package.json         ← 依赖与脚本
├── config/
│   └── bot.json5        ← 唯一配置文件
├── src/
│   ├── index.ts         ← 装配 + 启动入口
│   ├── transport/       ← 反向 WS 服务器 + OB11 API 客户端
│   ├── events/          ← OneBot 11 事件 zod schema 与解析
│   ├── router/          ← 触发判定 + 命令解析 + 分发 + 限流
│   ├── plugins/         ← Handler 契约 + 文件注册表（chokidar 热加载）
│   ├── config/          ← 配置 schema + JSON5 加载器（带回滚）
│   ├── llm/             ← OpenAI 兼容 LLM 共享客户端
│   └── commands/        ← 一文件一命令
├── docs/                ← 设计文档与历史归档
├── scripts/
│   └── smoke.mjs        ← 自动化验收脚本
└── logs/                ← pino 日志输出（gitignored）
```

## 文档怎么看

人类读者主要看：

- [`QUICKSTART.md`](./QUICKSTART.md) — 怎么把它跑起来、怎么接 NapCat、怎么排错。
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — 系统怎么运转、为什么这么设计。中文，详细，带"为什么"。**强烈推荐第一次读**，能让你后面读代码时省很多力气。
- [`docs/plans/`](./docs/plans/) — 想给项目加新功能时，先在这里写一份提案讨论清楚，再让 AI 实施。目录里有模板说明。
- [`docs/archive/`](./docs/archive/) — 已封存的历史文档（最初的整篇设计稿、过往 session 日志）。日常开发不必读。

`docs/` 下还有 4 篇文档（`architecture.md`、`config.md`、`plugins.md`、`acceptance.md`）。**它们写给 AI 代理用**，英文 + 干练 + 当作接口规格使用。人类读者读 `ARCHITECTURE.md` 那份中文版就够了——两者覆盖同样的事实，前者偏"是什么"，后者偏"为什么"。

[`CLAUDE.md`](./CLAUDE.md) 是给 AI 代理（Claude Code、Cursor 之类）用的导航文件，定义了它该读哪些、不该读哪些。人类不需要看它。

## 技术选型

- **TypeScript** + Node ≥ 20，ESM，pnpm。与 NapCat 同栈。
- **OneBot 11 反向 WS** 单连接同时承载事件推送和 API 调用。NapCat 主动连过来，断线 NapCat 自己重连。
- **不依赖任何 OneBot 框架**（NoneBot、Koishi 之类一律不用）。所有协议交互、连接管理、热加载、限流都自己实现。
- **zod** 做事件结构和配置的运行时校验。
- **chokidar** 监听配置和命令目录变化，实现热加载。
- **pino** 结构化日志，dev 用 pino-pretty。
- **内置 fetch + AbortController** 实现 LLM HTTP 调用，不用 `openai` SDK 也不用 `axios`。
- 配置文件用 **JSON5**，可以写注释、留尾逗号，比 JSON 友好。

## 安全与日志原则

下面几条是写代码时的硬规则，handler 作者也请遵守：

- WS token、用户消息正文、用户内容、API key、图片 URL **全部不能进 info 日志**。
- 每次命令触发只记一行结构化日志：`{ source, userId, groupId?, cmd, argvLen, latencyMs, ok, mid }`。
- LLM 调用日志只含元数据：`{ provider, model, latencyMs, msgCount, tokens, finishReason }`，绝不记 messages 内容或响应文本。
- handler 抛错由 dispatch 兜底，用户看到的是统一的"命令执行失败"，内部错误栈进 error 日志，不外泄。
- WS token 在握手时校验，错的直接 HTTP 401 拒掉。

## 验收

13 项功能验收用例（AC-1 .. AC-14）由 `scripts/smoke.mjs` 全自动跑：

```bash
pnpm smoke   # 期望: 13/13 passed
```

它会启一个临时端口的 bot 进程，自己扮演 NapCat 客户端用合成的 OB11 帧测各种触发场景（私聊、群聊、热加载、限流、错误隔离、错 token 拒绝等），跑完自动清理。

AC-15（24 小时长稳）目前没自动化，需要靠 pm2/launchd 实跑一周观察。AC-1 的真实 NapCat 联通也建议你接上号实测一遍。

## 进程管理

不强制方案。`pm2` / `launchd` / `systemd` 都行，自己写一份 `ecosystem.config.cjs` 或 plist 即可。`QUICKSTART.md` 里有 pm2 模板。

## License

未指定。这是个人项目，参考即用。
