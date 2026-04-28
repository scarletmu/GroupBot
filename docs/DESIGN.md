# QQBot 设计文档（NapCat 接入 / 命令式个人机器人）

> 文档位置：本计划文件即为最终交付的设计文档（含选型、架构、PRD 与验收）。
> 仓库：`/Users/wang/Documents/Dev/IM/`
> NapCatQQ 上游已克隆于 `NapCatQQ/`；Bot 主体将放在 `QQBot/`。

---

## 1. Context（背景与目标）

用户想用一个 QQ 小号搭一个**仅响应命令**的个人机器人：

- **触发场景**：私聊任意消息以 `/` 起始；或在被加入的指定群里 `@bot /xxx ...`。
- **不响应**：任何不符合上述触发条件的普通聊天内容。
- **后续**：希望能持续往里加新命令，但每次加命令不要动主程序。

NapCatQQ 是一个基于 NTQQ 的协议适配层，已经把 QQ 账号能力以 OneBot 11 标准暴露出来。所以本项目**不重新实现 QQ 协议**，只做一个 OneBot 11 客户端 + 命令路由 + 插件式 handler。

---

## 2. 技术选型（已与用户确认）

| 维度 | 选择 | 理由 |
|---|---|---|
| 协议适配 | **NapCatQQ**（已克隆）| 当前 OneBot 11 实现里登录稳定、维护活跃、与 NTQQ 同源；用户已经在用。 |
| Bot 语言 | **TypeScript (Node.js ≥ 20, ESM)** | 与 NapCat 同栈，复用 pnpm workspace 心智；类型系统对消息段（text/at/image…）这种判别联合特别合适。 |
| 协议库 | **自研轻框架**，不引入 NoneBot2 / Koishi | 命令量级小，全套框架反而是负担；自己控制连接、心跳、重连、限流。 |
| 传输方式 | **Reverse WebSocket**（NapCat 主动连 bot）| 单条长连接同时承载事件推送和 API 调用；NapCat 内置断线自动重连；本机常驻最稳。 |
| 校验 | **zod** | OneBot 11 事件结构复杂，运行时校验避免静默漏字段。 |
| 配置 | **JSON5 文件** + chokidar 热加载 | 与 NapCat 配置风格一致；`config/bot.json5` 改完即时生效，无需重启进程。 |
| 持久化 | 本期**不引入数据库** | 命令均为无状态；后续若有备忘 / 定时类命令再加 SQLite（better-sqlite3）。 |
| 日志 | **pino**（JSON）+ pino-pretty（dev）| 结构化、便于排错；记录每次命令调用与回复 message_id。 |
| 进程管理 | **pm2** 或 launchd（任选） | 文档里给出 pm2 推荐配置，用户自行选择。 |

**显式不选**：
- ❌ NoneBot2 / Koishi — 框架开销 > 收益。
- ❌ HTTP POST 回调 — 需要双端口且无序列化关联，调试比 WS 麻烦。
- ❌ Forward WS — 断线重连要 bot 端实现，省事不如反向。

---

## 3. 架构设计

### 3.1 部署拓扑

```
┌────────────────┐   reverse WS    ┌────────────────────┐
│  NapCatQQ      │ ──────────────▶ │  QQBot (本项目)     │
│  (NTQQ 进程)   │ ◀────────────── │                    │
│  端口: -       │   API 调用       │  ws://0.0.0.0:6700 │
└────────────────┘                  └────────────────────┘
       ▲                                     │
       │ 扫码登录                              │ 加载
   手机 QQ                              config/bot.json5
                                       commands/*.ts
```

NapCat 的 OneBot 11 适配器配置（`NapCatQQ/config/onebot11_<uin>.json`）里启用 `websocketClient`（反向 WS 客户端），URL 指向 `ws://127.0.0.1:6700`，token 与 bot 端一致。

### 3.2 进程内部模块

```
QQBot/
├── package.json
├── tsconfig.json
├── config/
│   └── bot.json5                ← 唯一配置文件，热加载
├── src/
│   ├── index.ts                 ← 入口：装配 + 启动
│   ├── transport/
│   │   ├── ws-server.ts         ← 反向 WS 服务器、token 校验、心跳
│   │   └── ob11-client.ts       ← API 调用封装（send_private_msg / send_group_msg），echo 关联请求-响应
│   ├── events/
│   │   ├── schema.ts            ← zod schema：MessageEvent / Segment 联合
│   │   └── parse.ts             ← 把原始 JSON 解析成 typed event
│   ├── router/
│   │   ├── trigger.ts           ← 判定是否触发：私聊起始 `/`，或群里 at-self + `/`
│   │   ├── parse-cmd.ts         ← 提取 cmd 名 + argv（去掉 at 段、shell-like 分词）
│   │   └── dispatch.ts          ← 查表分发 + 错误兜底 + 限流（令牌桶）
│   ├── plugins/
│   │   ├── registry.ts          ← 插件注册表 + 热加载（chokidar 监听 commands/）
│   │   └── api.ts               ← 暴露给 handler 的最小 API（reply/log/cfg）
│   ├── config/
│   │   ├── schema.ts            ← bot.json5 的 zod schema
│   │   └── loader.ts            ← 加载 + 热重载 + 校验失败回滚
│   └── commands/                ← 一个文件一个命令；新增不改主程序
│       └── help.ts              ← 首批唯一命令
└── logs/
```

### 3.3 关键数据流

1. NapCat 通过反向 WS 连上 `ws://127.0.0.1:6700`，握手时带 `Authorization: Bearer <token>`，bot 校验后放行。
2. NapCat 推送事件 JSON → `events/parse.ts` 用 zod 解析为 `PrivateMessageEvent | GroupMessageEvent | …`；非消息事件（meta / notice）直接落日志后忽略。
3. `router/trigger.ts` 判定：
   - 私聊：`message_type === 'private'` 且首段 text 以 `/` 起始 → 触发。
   - 群聊：`message_type === 'group'` 且 `group_id ∈ allowedGroups` 且消息段含 `{type:'at', data:{qq: self_id}}` 且去掉 at 后首段 text 以 `/` 起始 → 触发。
   - 其它一律丢弃（含转发、表情、纯图等）。
4. `router/parse-cmd.ts` 抽出 `cmd` 与 `argv`（用 `string-argv` 之类做 shell 风格分词，兼顾 `"双引号"`）。
5. `router/dispatch.ts` 查 `plugins/registry`：
   - 命中 → 调 handler，传 `ctx = { event, argv, reply, log, cfg }`。
   - 未命中 → 回 "未知命令，/help 查看"（仅在私聊或显式 `@bot /xxx` 已成立时回，不污染群）。
   - handler 抛错 → 记日志 + 回 "命令执行失败"（不暴露内部错误信息）。
   - 触发频次限制（默认 5 条/10 秒/用户，令牌桶）。
6. handler 用 `ctx.reply(segments)` 调 `ob11-client.send_*_msg`；client 用 OneBot `echo` 字段关联响应。

### 3.4 配置 schema（`config/bot.json5`）

```json5
{
  // 反向 WS
  listen: { host: "127.0.0.1", port: 6700, token: "change-me" },
  // 自身 QQ 号（用于 at 判定）
  selfId: 10001,
  // 群白名单：只有这些群里被 at 才会响应
  allowedGroups: [123456, 789012],
  // 用户白名单：私聊只接受这些 QQ；空数组 = 所有人
  allowedUsers: [],
  // 触发前缀；默认 "/"，可改成 "!" 之类
  prefix: "/",
  // 限流
  rateLimit: { perUser: 5, windowMs: 10000 },
  // 命令插件目录（相对项目根）
  commandsDir: "src/commands",
  // 日志
  log: { level: "info", dir: "logs" }
}
```

热加载语义：`allowedGroups / allowedUsers / prefix / rateLimit / log.level` 改完即生效；`listen.*` 改动需要重启进程（启动期日志会提示）。

### 3.5 插件契约

```ts
// src/plugins/api.ts
export interface CommandHandler {
  name: string;                      // 命中 cmd 名（不带 prefix）
  description: string;               // /help 用
  usage?: string;                    // 例: "/echo <text>"
  scope?: 'private' | 'group' | 'both'; // 默认 both
  handle(ctx: CommandContext): Promise<void>;
}

export interface CommandContext {
  event: PrivateMessageEvent | GroupMessageEvent;
  argv: string[];
  reply(content: string | Segment[]): Promise<void>;
  log: pino.Logger;
  cfg: BotConfig;
  // 当前已注册命令快照（按 name 排序），仅供 /help 渲染列表使用
  listCommands(): readonly CommandHandler[];
}
```

新增命令 = 在 `src/commands/` 加一个文件 `default export` 一个 `CommandHandler`。`registry` 监听该目录，文件落盘后重新 import（带 cache busting）即生效，不需要重启进程。

---

## 4. PRD（产品需求 + 验收标准）

### 4.1 功能需求

| ID | 需求 | 优先级 |
|---|---|---|
| F1 | 私聊：消息以 `prefix` 起始时，按命令路由分发并回复 | P0 |
| F2 | 群聊：仅当 `group_id` 在白名单 **且** 消息 at 了 bot 自身 **且** 去掉 at 后剩余文本以 `prefix` 起始时，才路由分发 | P0 |
| F3 | 任何不满足 F1/F2 的消息**完全不回复、不打日志噪声**（debug 级别可记） | P0 |
| F4 | 命令未知时，仅回友好提示 + 引导 `/help` | P1 |
| F5 | 内置 `/help`：列出当前已注册命令的 name / description / usage | P0 |
| F6 | 命令以单文件插件形式组织在 `src/commands/`，新增/修改命令文件无需重启进程 | P0 |
| F7 | `config/bot.json5` 修改后，除监听端口外的字段热生效 | P1 |
| F8 | NapCat 断线由其自动重连；bot 侧只需正确响应握手与心跳 | P0 |
| F9 | 单用户限流（默认 5 条/10s）；超限时回 "操作过于频繁" 一次，期间静默 | P1 |
| F10 | 启动时输出日志：监听地址、白名单大小、已注册命令清单 | P1 |

### 4.2 非功能需求

- **延迟**：本机回环下，从收到事件到调用 send API ≤ 100ms（不含 NapCat 自身耗时）。
- **稳定性**：连续运行 7 天无内存泄漏（RSS 增长 < 50MB）。
- **安全**：WS token 必须校验；handler 抛错不能让进程退出；日志不打印 token 与完整消息体（仅打 message_id + cmd）。
- **可观测**：每次触发记录一行 JSON：`ts, source(private/group), userId, groupId?, cmd, argv.length, latencyMs, ok`。

### 4.3 范围外（明确 Out of Scope）

- 主动推送、定时任务、订阅类命令。
- 多账号 / 多实例。
- WebUI、远程管理面板。
- 数据库与持久化的命令状态（备忘录、统计等）。
- 富媒体上行（OCR、语音转文字等）。

### 4.4 验收用例（必须全部通过才算交付）

> 记号：✅ 应回复，🚫 应不回复。

| # | 场景 | 操作 | 预期 |
|---|---|---|---|
| AC-1 | NapCat 反向 WS 接入 | 配置 NapCat `websocketClient` 指向 `ws://127.0.0.1:6700`，启动 bot | bot 日志出现 "client connected uin=…"；NapCat 日志显示连接成功 |
| AC-2 | 私聊正向命令 | 用另一个 QQ 私聊小号发 `/help` | ✅ 收到命令清单消息 |
| AC-3 | 私聊普通聊天 | 私聊发 "你好" | 🚫 无任何回复，bot 仅 debug 级别记录 |
| AC-4 | 私聊未知命令 | 私聊发 `/foo` | ✅ 回 "未知命令，/help 查看" |
| AC-5 | 群里 at + 命令 | 在白名单群里发 `@bot /help` | ✅ 群内回命令清单 |
| AC-6 | 群里只 at 不带命令 | 在白名单群发 `@bot 在吗` | 🚫 无回复 |
| AC-7 | 群里只命令不 at | 在白名单群发 `/help`（不 at） | 🚫 无回复 |
| AC-8 | 非白名单群 at | 在未列入 `allowedGroups` 的群里 `@bot /help` | 🚫 无回复 |
| AC-9 | 触发前缀变更热生效 | 把 `prefix` 改成 `!` 保存，立刻私聊 `!help` | ✅ 命中；同时 `/help` 不再命中 |
| AC-10 | 群白名单热生效 | 移除某群 ID 后保存，再在该群 `@bot /help` | 🚫 无回复，无需重启 |
| AC-11 | 新增命令热加载 | 在 `src/commands/` 加 `ping.ts` 并保存 | 不重启进程，私聊 `/ping` 即可命中 |
| AC-12 | 限流 | 私聊 1 秒内连发 6 次 `/help` | 前 5 次 ✅，第 6 次回 "操作过于频繁" 一次，再发静默 10s |
| AC-13 | handler 异常隔离 | 临时往一个命令里 `throw new Error('x')` | ✅ 回 "命令执行失败"，进程不退出，错误栈进 error 日志 |
| AC-14 | 错误 token 拒绝 | NapCat 用错的 token 连接 | bot 拒绝 WS 升级（HTTP 401），日志记录拒绝来源 |
| AC-15 | 长稳 | 跑 24 小时，期间手动制造 NapCat 重启一次 | bot 不崩溃，重启后命令恢复可用，RSS 增长 < 20MB |

---

## 5. 实施顺序（建议工时锚点）

1. **P0 框架**：`package.json` + tsconfig + transport/ws-server + ob11-client + zod schema → AC-1, AC-14。
2. **P0 路由**：trigger + parse-cmd + dispatch；写死 `/help` handler → AC-2~AC-8。
3. **P1 配置 & 热加载**：bot.json5 + chokidar → AC-9, AC-10。
4. **P0 插件机制**：commands 目录扫描 + 重载 → AC-11。
5. **P1 限流 & 错误隔离 & 日志**：→ AC-12, AC-13。
6. **NFR 验证**：长稳 + 内存观察 → AC-15。

---

## 6. 关键文件 / 复用引用

- **复用（NapCatQQ 上游，仅参考勿改）**
  - `NapCatQQ/packages/napcat-onebot/types/message.ts` — `OB11MessageDataType` 等消息段类型，作为 zod schema 蓝本。
  - `NapCatQQ/packages/napcat-onebot/action/msg/SendPrivateMsg.ts` 与 `…/group/SendGroupMsg.ts` — 确认 API 入参契约。
  - `NapCatQQ/packages/napcat-onebot/config/config.ts` — 反向 WS 字段名对齐参考。

- **新增**
  - `QQBot/` 下 §3.2 列出的全部文件。
  - `NapCatQQ/config/onebot11_<uin>.json` 中启用 `websocketClient`（这一项**需要用户在登录小号后由 WebUI 或手工编辑配置**，文档化在 `QQBot/README.md` 的"接入步骤"段）。

- **文档**
  - 新建 `QQBot/README.md`：写"接入步骤 / 启动 / 加新命令 / 配置项"。本设计文档不进仓库，只做规划用。

---

## 7. 验证如何端到端跑通

1. NapCat：在其 WebUI 扫码登录小号 → 配置 OneBot11 → 反向 WS 客户端 → 启用 → 重启 NapCat。
2. Bot：`cd QQBot && pnpm i && pnpm dev`。观察日志 `client connected uin=<小号>` 与 `commands loaded: [help]`。
3. 主号私聊小号 `/help` → 收到命令清单 → AC-2 通过。
4. 把主号和小号拉进一个测试群，把群 ID 写入 `allowedGroups`，主号 `@bot /help` → AC-5 通过。
5. 按 §4.4 全表跑一遍。
