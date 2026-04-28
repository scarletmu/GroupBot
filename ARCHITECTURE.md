# Architecture 架构详解

> 这份文档写给**想理解系统是怎么运转的人类读者**——你想加新功能、做技术决策、回答"为什么这么设计"之类的问题。AI 代理不需要读这份，它读 `docs/architecture.md` 那份英文干练版就够了。
>
> 本文跟 `docs/architecture.md` **覆盖同样的事实**，但风格不同：那份是给机器看的"接口规格"，这份是给人看的"为什么"。如果两者哪天对不上，以 `docs/architecture.md` 和实际代码为准。

---

## 1. 一句话定位

QQBot 是一个**只响应 `/<命令>` 的 QQ 个人小机器人**，本身**不实现 QQ 协议**。它通过反向 WebSocket 连接 NapCatQQ，把 OneBot 11 标准的事件解析、过滤、路由到本地的"命令处理器"（handler），然后把回复用 OneBot API 发回 NapCat、由 NapCat 发到 QQ。

它不是"聊天机器人"——任何不符合命令格式的消息它都装作没看见。这是有意的设计选择，不是缺失功能。

```
┌────────────────┐   反向 WS（一条长连接）   ┌────────────────────┐
│  NapCatQQ      │ ────事件推送────────────▶ │  QQBot              │
│  (NTQQ host)   │ ◀────API 调用──────────── │                     │
│                │                            │  ws://0.0.0.0:6700  │
└────────────────┘                            └────────────────────┘
       ▲                                                │
       │ 扫码登录                                        │ 加载
   小号 QQ                                       config/bot.json5
                                                src/commands/*.ts
```

NapCat 自己解决"如何用一个 QQ 号登录、维持在线、与 NTQQ 内核交互"。我们在它之上做"消息怎么过滤、命令怎么执行、回复怎么发出去"。两边的接口契约就是 OneBot 11——一份社区维护的、跟具体实现解耦的事件/动作 schema。

---

## 2. 模块布局

```
src/
├── index.ts            ← 装配 + 启动入口
├── transport/          ← 跟 NapCat 打交道的两层
│   ├── ws-server.ts    ← 反向 WS 服务器、token 校验、心跳
│   └── ob11-client.ts  ← 主动调 OneBot API（send_*_msg 等），靠 echo 关联请求-响应
├── events/             ← 事件结构定义与解析
│   ├── schema.ts       ← zod schema：消息事件、消息段、API 响应
│   └── parse.ts        ← 把原始 JSON 帧分类成 typed event
├── router/             ← 消息进来到 handler 之间的全部决策逻辑
│   ├── trigger.ts      ← 判定：这条消息要不要触发命令？
│   ├── parse-cmd.ts    ← 把命令文本拆成 cmd + argv
│   └── dispatch.ts     ← 查表分发 + 限流 + 错误隔离
├── plugins/            ← 命令的注册与上下文契约
│   ├── api.ts          ← CommandHandler / CommandContext 接口
│   └── registry.ts     ← 文件目录的注册表，靠 chokidar 热加载
├── config/             ← 配置加载
│   ├── schema.ts       ← BotConfig 的 zod schema
│   └── loader.ts       ← JSON5 解析 + 校验失败回滚 + 热重载
├── llm/                ← OpenAI 兼容 LLM 共享客户端
│   ├── api.ts          ← 对外契约（类型 + LlmError）
│   └── client.ts       ← 用内置 fetch 实现的调用
└── commands/           ← 一文件一命令，热加载
    ├── help.ts
    └── translate.ts
```

每个目录的职责是有意识切开的：

- **transport** 是协议层，只关心"跟 NapCat 怎么对话"。换协议（比如未来 OneBot 12）时影响范围限于这一层。
- **events** 是数据层，事件 schema 集中在这里，别处只用类型不解析。
- **router** 是决策层，"这消息要不要响应、命中哪条命令"全部在这一层判定。
- **plugins** 是扩展点，对外暴露最小契约（你写 handler 时唯一需要 import 的就是 `plugins/api`）。
- **config** 是注入点，整个进程的可调参数都从一份文件来。
- **llm** 是基础设施，给 handler 用的 LLM 调用工具。
- **commands** 是业务，每个文件代表一个具体功能。

这种切分的好处：动 router 的人可以不懂 transport，写命令的人可以不懂 router。

---

## 3. 一条消息的完整生命周期

我们顺着一条 QQ 群消息走一遍，看每个模块在做什么：

**第 1 步：握手与连接**

NapCat 启动后主动连 `ws://127.0.0.1:6700`，HTTP 升级请求里带 `Authorization: Bearer <token>`。`ws-server.ts` 在升级握手时把这个 token 跟 `cfg.listen.token` 比对：

- 不匹配 → 直接 HTTP 401 拒掉，记一行带 peer addr 的 warn 日志（**不**记 token 内容）。
- 匹配 → 升级为 WebSocket，启动 30 秒一次的 ping/pong 心跳。

整个进程同时只接受一条 NapCat 连接（多连进来的会顶替前一条）。这是一对一关系，跟 NapCat 的反向 WS 客户端定位一致。

**第 2 步：事件推送**

群里有人发了 `@小号 /help`。NapCat 这边把它打包成 OneBot 11 事件 JSON 推过来，结构大致是：

```json
{
  "post_type": "message",
  "message_type": "group",
  "group_id": 123456,
  "user_id": 987654,
  "self_id": 10001,
  "message_id": 42,
  "message": [
    { "type": "at",   "data": { "qq": 10001 } },
    { "type": "text", "data": { "text": " /help" } }
  ],
  "raw_message": "[CQ:at,qq=10001] /help",
  "time": 1730000000
}
```

`events/parse.ts` 用 zod 校验这个 JSON，分类成 `private | group | meta | notice | request | api-response | unknown | invalid` 之一。校验失败的会记 warn 后丢掉（不会让进程崩）。这层的价值是：下游所有代码拿到的都是 typed 数据，不用自己写 `if (typeof ... === 'string')` 这种防御代码。

**第 3 步：触发判定**

`router/trigger.ts::evaluateGroup` 跑一连串检查：

1. `message_type === 'group'`？是。
2. `group_id ∈ cfg.allowedGroups`？查白名单。**不在白名单 → 静默丢弃**（debug 日志记一笔 reason="not-allowed-group"，info 日志一行都没有）。
3. 有 `{ type: 'at', data: { qq: cfg.selfId } }` 段吗？有。
4. 把消息段头部的 `reply` / `at` / 相邻的纯空白 text 段剥掉，剩下的首段 text 是 `" /help"`，左 trim 变成 `"/help"`。
5. 它以 `cfg.prefix` （默认 `/`）开头吗？是 → **触发**，剥完后的命令文本是 `/help`。

私聊的判定更简单：`message_type === 'private'` && 首段 text 以 prefix 开头。

**关键设计点**：未触发时**完全静默**，连 info 日志都不打。这是因为 QQ 群里日常聊天会产生海量事件，info 日志会被淹没；同时未触发的消息记到 info 也违反"不记用户内容"的原则。

**第 4 步：命令解析**

`router/parse-cmd.ts` 把 `/help` 处理成 `{ cmd: 'help', argv: [] }`。如果是 `/translate "hello world"`，会产出 `{ cmd: 'translate', argv: ['hello world'] }`——支持 shell 风格的引号分词，靠 `string-argv` 库。命令名统一小写。

**第 5 步：限流**

`router/dispatch.ts::checkRateLimit` 给每个 `userId` 维护一份 `{ times: number[], warnedUntil: number }`。

- 滑动窗内调用次数 < `perUser`：放行，把当前时间戳加进 `times`。
- 第一次超额：回一句"操作过于频繁，请稍后再试"，把 `warnedUntil` 设为 `now + windowMs`。
- 后续仍在 `warnedUntil` 内的超额：**完全静默**，不再回提示（避免一直被刷屏）。
- 窗口滑出：状态自然恢复。

这种"令牌桶 + 警告一次后静默"是为了平衡：用户第一次撞到限流应当知道发生了什么，但持续撞墙时不该让 bot 配合刷屏。

**第 6 步：查表分发**

`plugins/registry.ts` 按 cmd 名查 handler。这一层在启动时已经扫描了 `src/commands/` 下所有 `.ts` 文件，每个文件 dynamic import 后取 `default` 导出，校验它确实是一个 `CommandHandler`，按 `name` 入表。

启动后注册表会通过 chokidar 监听这个目录的文件变化：

- 新增文件 → 加载并注册。
- 修改文件 → 重新加载（这里有个小坑：Node 的 ESM 缓存没法 invalidate，所以我们 import 时附 `?v=Date.now()` query，让每次修改产生一个新的 module URL，绕过缓存）。
- 删除文件 → 注销。

整个过程不重启进程。这就是 AC-11 验收要点。

回到主流程：找到 `help` handler，调它。

**第 7 步：构造上下文，跑 handler**

`dispatch.ts` 构造一个 `CommandContext` 对象交给 handler：

```ts
{
  event,                           // 原始事件，handler 想读什么自取
  argv,                            // 已解析的参数
  reply: (content) => ...,         // 回复函数，自动选私聊/群路由
  log,                             // 子 logger，scoped { cmd: 'help' }
  cfg,                             // 当前配置快照（即拍即用，不会变）
  listCommands: () => ...,         // 命令列表快照，给 /help 用
  llm,                             // LLM 共享客户端
}
```

`help.handle(ctx)` 跑起来，调 `ctx.reply(...)`。

**第 8 步：发回复**

`ctx.reply(content)` 内部调 `transport/ob11-client.ts::sendGroupMsg(group_id, segments)`。这层把 OneBot API 调用包成 JSON 帧（带一个唯一 `echo` 字段做请求-响应关联），通过 WebSocket 发给 NapCat。

NapCat 收到后调 NTQQ 把消息发出去，再返回一个带相同 `echo` 的 API 响应帧给我们，`ob11-client` 用 `echo` 把响应跟当初的 promise 对上，resolve。整个 API 调用有 10 秒超时；超时会让 promise reject。

handler 顺利返回 → `dispatch.ts` 记一行 info 日志：

```json
{
  "source": "group",
  "userId": 987654,
  "groupId": 123456,
  "cmd": "help",
  "argvLen": 0,
  "latencyMs": 23,
  "ok": true,
  "mid": 42
}
```

**异常路径**：handler 抛错 → dispatch 的 try/catch 接住 → 回一句"命令执行失败"给用户，错误栈进 error 日志（带 cmd 和 mid，但不带消息内容）。进程不退出。这是 AC-13。

---

## 4. 触发规则为什么这么设计

触发规则是这个项目里最容易踩坑、也最值得理解动机的部分。

**为什么群里要求 at + 命令前缀？**

- **at** 是给 QQ 客户端看的——群成员能看到"哦，他在跟 bot 说话"，而不是"咦，这家伙怎么突然对所有人喊命令"。
- **命令前缀** 是给 bot 看的——区分"@bot 在吗"和"@bot /help"。如果只看 at，那任何 at 都会触发，扰民。

两个条件**必须同时满足**。这导致了 AC-6（群里只 at 不带命令静默）和 AC-7（群里只命令不 at 静默）这两条乍看奇怪、实则保护账号的用例。

**为什么私聊不要求前缀以外的东西？**

私聊场景下没有"扰民"问题——别人看不见。只看前缀就够了。这就让私聊比群聊更"宽"，可以做 quick test。

**为什么不响应的消息要完全静默？**

三个原因：

1. **隐私**：日常聊天的内容不该进 bot 的 info 日志。debug 级别保留 reason 字段（比如"not-allowed-group"）足够排错，不需要把消息体也记下来。
2. **降噪**：QQ 群每分钟可能几十上百条消息，info 日志会淹没真正有信息量的命令调用记录。
3. **避免误伤**：bot 偶尔说错话比想象中更糟（被踢、被报告、账号风险）。能少说就少说。

这条规则在加新功能时很容易被破——比如有人会想"加一个 /joke 命令吧，匹配不到时随便说点什么"。**不要这么干**。匹配不到就是匹配不到。

---

## 5. 命令插件机制

设计目标：**新增/改命令不要重启进程**。这背后两个支撑：

**目录扫描**：`registry.ts` 启动时扫 `cfg.commandsDir`，所有 `.ts` 文件都尝试 dynamic `import()`，通过 `isCommandHandler` 校验后入表。校验只看 `name`、`description`、`handle` 三个字段，松散到任何"看起来像 handler"的对象都能注册（这是有意的——降低写命令的门槛）。

**ESM 缓存破坏**：Node ESM 的 `import()` 默认会缓存 module URL，文件内容变了也不重新执行。绕过办法是给 URL 加一个 query：`import('file:///abs/path/to/cmd.ts?v=' + Date.now())`。每次重新加载产生一个新 URL，新 URL 没缓存，于是新代码生效。

旧版本的 module 不会被回收（小内存泄漏），但这个 leak 在实际使用中可以忽略——你不会一天改 1000 次命令文件。

**为什么不是 watch + restart？** 全进程重启会断 NapCat 的 WS 连接，NapCat 重连一般几秒到十几秒。频繁重启会把 bot 体验毁掉。文件级热加载只影响那一个 handler，其它命令、连接、限流状态都不受打扰。

---

## 6. 配置热加载

`config/loader.ts` 干的事：

- 启动时读一次 `bot.json5`，过 zod schema，挂在 `loader.value`。
- 启动后 chokidar 监听文件变化（debounce 100ms，避免编辑器原子写入触发两次）。
- 每次变化重新读 + 重新 parse + 重新过 schema：
  - 过了 → emit `change` 事件，新值替换旧值，订阅方刷新。
  - 没过（比如你在文件里写错了 JSON5 语法、或者新值不符合 schema）→ **保留旧值**，记一行 error 日志，bot 继续正常运转。

这种"校验失败回滚"是为了避免你一个手抖把 bot 弄崩。生产环境改配置最怕的就是改错了重启起不来——这里彻底回避掉，bot 永远跑在最后一份合法配置上。

**为什么不是所有字段都热加载？**

`listen.host` / `listen.port` / `listen.token` 改了得重启。原因是 WebSocket 服务器一旦绑定到一个 host:port，没法不停服重新绑定；token 是握手时校验，已经握过手的连接没必要中途改 token（也没意义——NapCat 那边的 token 已经发过了）。

loader 检测到 `listen.*` 变更时会 emit `restart-required` 事件，启动日志会有警告，但**不会自动重启**——这是有意的，避免你正在调试时被猛地踢掉。需要你自己 ctrl-c 重启。

---

## 7. 错误隔离的层次

bot 跑起来就不应该崩。这通过几层防御实现：

**第 1 层：zod 在边界**。所有从 NapCat 进来的事件、所有从配置文件读到的字段，都过 zod。畸形数据进不到核心逻辑。

**第 2 层：dispatch 的 try/catch**。handler 抛任何错都被这层接住，转成统一的"命令执行失败"回复 + error 日志。`router/dispatch.ts` 的 `runTriggered` 方法本身不可能抛 unhandled——所有 await 都在 try 里。

**第 3 层：进程级 unhandledRejection / uncaughtException**。`src/index.ts` 注册了这两个 handler，把异常 log 出来但**不退出进程**。这是兜底——理论上前两层接住所有错了，第三层只是防止漏网。

**第 4 层：handler 自己 catch LlmError 之类**。这是 handler 作者的责任。比如 `/translate` 显式 catch `LlmError('NOT_CONFIGURED')` 给一句友好提示，其它 `LlmError` 让它穿透到第 2 层吃统一的"命令执行失败"。

整体哲学：**handler 写崩了不能让 bot 崩**。一个 handler 变 buggy，最多影响那个命令的回复，其它命令、所有用户、整个连接都不受波及。

---

## 8. LLM 共享客户端

加 LLM 能力时一个核心选择是："**让用户跟 LLM 直接对话**"还是"**让 handler 用 LLM 实现具体功能**"。我们选了后者。

**为什么不要直接对话？**

- 直接对话本质上把 bot 变成了"另一个 ChatGPT"，丧失了"命令式"这个独特定位。
- 直接对话会让账号风险大涨——QQ 安全机制对"看起来像聊天的高频消息"特别敏感。
- 直接对话会让用量失控——每条群消息 at 一下都能跑 LLM 调用，钱包很快受不了。

所以我们的 LLM 是**包在 `ctx.llm` 里的工具**，handler 决定什么时候用、用什么 prompt、解析成什么输出。`/translate` 是第一个示例：输入有界（一条文本或几张图）、输出有界（一句中文译文）、调用频率有界（用户得显式发 `/translate`）。

**多 provider 命名表的选择**

```json5
llm: {
  default: "openai",
  providers: {
    openai:   { baseUrl, apiKey, model, ... },
    deepseek: { baseUrl, apiKey, model, ... },
  }
}
```

而不是单 provider。原因：

- 不同 provider 强项不同（视觉、代码、中文等），handler 可以指定用哪个。
- 万一某家挂了或涨价，可以快速切。
- API key 和 baseUrl 是耦合的（不同 provider 走不同域名），分开存比平铺更清晰。

`default` 必须在 `providers` 里——zod refine 校验。

**日志安全**

LLM 调用日志只记 `{ provider, model, latencyMs, msgCount, promptTokens, completionTokens, finishReason }`——元数据。绝不记 messages 内容、响应文本、图片 URL（图片 URL 也是用户上传的内容）、apiKey。HTTP 错误响应的 body 片段只进 debug 日志，避免上游某些错误响应里把 apiKey 回显进 error message 时漏到 info。

这条规则跟全局的"不记用户内容"一脉相承。LLM 调用是隐私敏感场景的放大器（既有用户输入又有第三方 API 的中间结果），更要严格。

---

## 9. 安全模型

把整个系统从外向内排几道线：

**最外圈：QQ 平台**。NapCat 自己会被 NTQQ 限速、风控、踢号。这部分我们没法控制，只能"少做高频高量的事"——这就是为什么所有命令都被 prefix + at 严格约束的原因之一。

**第二圈：NapCat ↔ QQBot 的 WS**。靠 `listen.token` 校验。token 必须是长随机串，建议 `openssl rand -hex 16`。校验在 HTTP upgrade 阶段做，错的连接根本升级不上。

**第三圈：白名单**。`allowedGroups` 限定哪些群响应，`allowedUsers` 限定哪些 QQ 能私聊。两个都默认空：群默认全拒，私聊默认全开。这是不对称的——群里风险大，所以 deny by default；私聊只有跟你加好友的人能发，本身有 QQ 自己的好友过滤。

**第四圈：限流**。每用户每窗口最多几次。防止单用户疯狂触发刷屏 / 烧 LLM 配额。

**第五圈：handler 隔离**。handler 抛错只影响那次调用，其它请求/用户/连接都不受影响。

**横切：日志安全**。任何一层都不写 token、消息体、apiKey、用户内容。这是承诺，写新代码时要主动维护。

---

## 10. 锁定决策与边界

下面这些是项目"宪法"，写代码时不要试图绕过。如果真的要做，先开会改宪法（也就是改 `docs/architecture.md` 和这份文档）。

**锁定**

- TS + Node ≥ 20 + ESM + pnpm。不引 CommonJS。
- 不引入任何 OneBot 框架（NoneBot、Koishi 等）。原因：框架带来的重量（依赖树、抽象、生命周期、文档负担）对一个个人小机器人是负值。
- 反向 WS 唯一接入方式。不做 HTTP 回调、不做正向 WS。
- 单一配置文件。不引入环境变量、不引入分层配置覆盖。
- 不引入数据库。命令默认无状态。
- LLM 调用不用 `openai` SDK，不用 `axios`。Node 内置 `fetch` + `AbortController` 完全够。

**Out of scope**

- 主动推送、定时任务、订阅。机器人是被动的——它响应消息，不发起对话。
- 多账号 / 多实例。一个进程一个号。要多个开多个进程。
- Web UI、远程管理面板。配置就是一份文件。
- 持久化命令状态。命令是无状态函数。
- 富媒体上行（OCR、ASR 等）。用户要这种功能，让 handler 自己用 LLM 多模态去做。
- 用户↔LLM 直接对话。已经讲过了，不再重复。

每条 out-of-scope 不是因为做不了，是因为**做了之后系统会变得不像现在这样小、可读、可控**。

---

## 11. NapCat 担了什么

值得分清楚我们和 NapCat 的边界：

| 责任 | 谁担 |
|---|---|
| QQ 协议（NT 内核交互） | NapCat |
| 扫码登录 / 维持在线 / 断线重连（QQ 侧） | NapCat |
| 把 NTQQ 内部事件翻译成 OneBot 11 JSON | NapCat |
| 接受 OneBot 11 API 调用并执行（发消息、获群成员等） | NapCat |
| 反向 WS 客户端：主动连 bot、断线重连（与 bot 之间） | NapCat |
| 反向 WS 服务器：接受 NapCat 连接 | QQBot |
| token 校验、心跳维持 | QQBot |
| 事件 schema 校验、解析 | QQBot |
| 触发规则、命令路由、限流 | QQBot |
| 命令处理（业务逻辑） | QQBot |
| 配置管理、日志、错误隔离 | QQBot |
| LLM 调用（如果命令需要） | QQBot |

NapCat 是基础设施。我们的代码不去碰它（它在 `../NapCatQQ/` 目录下作为只读参考存在）。如果未来 NapCat 出了 OneBot 12 适配版，我们改 `transport/` 和 `events/schema.ts` 就够，业务层不动——这就是分层的价值。

---

## 12. 如何推进这个系统

加新东西的时候，从大到小问自己几个问题：

1. **它是不是真的要写在这个 bot 里？** 大量"想加的功能"其实更适合一个 cron 脚本、一个独立 web 服务、或者直接用别的工具。bot 的甜蜜区是"在 QQ 里通过命令触发的事"。
2. **它是不是用户主动触发的？** 不是的话，多半属于 out-of-scope（参见 §10）。
3. **它能放进一个 handler 里吗？** 能 → 加一个 `src/commands/xxx.ts`。不能 → 你要的可能是底层基础设施（像 LLM 客户端那样），需要先讨论清楚。
4. **它需要状态吗？** 需要 → 这是个大决策，要明确加状态的层次（进程内 / SQLite / 文件 / etc）和影响。无状态是默认。
5. **它的失败模式是什么？** API 挂了、超时、用户输入恶意、密钥泄漏……每个都要在设计时想过。
6. **它的日志能保证不漏密吗？** 每次新写带网络调用的代码都要回头检一遍。

这些问题想清楚了再去 `docs/plans/` 写一份提案，跟自己/合作者过一遍，再让 AI 实施。**不要直接告诉 AI"加个 X 功能"**——AI 会做出来，但很可能它做的"X"不是你想要的"X"，因为边界没钉死。

---

如果你读完这份还有"为什么"没解答的，去 `docs/archive/DESIGN.md` 翻翻最初的设计稿——那里有更多决策时刻的原始动机。
