# Quickstart 上手手册

> 这份文档是写给**人类操作者**的，目的是把 QQBot 从零跑起来，并连通到一个真实的 NapCat 实例。AI 代理不需要主动读这份——它读 `CLAUDE.md` 索引到的设计文档就够了。

读完这份你应该能完成的事：

1. 在本机装好依赖、改好配置。
2. 让 NapCat 主动连上你的 QQBot。
3. 跑通自动化验收（13 项 smoke 测试全过）。
4. 用主号给小号发 `/help` 收到回复。
5. 把测试群拉起来跑通群里 `@bot /help`。
6. （可选）配置 LLM provider 让 `/translate` 和 `/image` 工作。
7. （可选）启用 `cfg.history` 让 `/summary` 工作。
8. 进程管理（pm2 / launchd）让它常驻。
9. 排错。

预计 10–15 分钟。

---

## 0. 前置条件

需要你已经有：

- **Node.js ≥ 20**：`node -v` 看一下。
- **pnpm**：`npm i -g pnpm` 即可装。
- **NapCatQQ 已安装并登录"小号"**：也就是机器人本体的 QQ 账号。建议**专门起一个小号**，不要用主号。NapCat 自己怎么装、怎么扫码登录看它的官方文档（[github.com/NapNeko/NapCatQQ](https://github.com/NapNeko/NapCatQQ)）。
  - **本地调试懒人路径**：本仓库 [`docker/napcat/`](./docker/napcat/) 备了一份 `run.sh`，跑起来就是一个本地 NapCat 容器（WebUI 走 `http://localhost:16099/webui`，端口都换成了 5 位避免冲突）。只用来调试，不要拿去跑生产。具体步骤看 [`docker/napcat/README.md`](./docker/napcat/README.md)。
- **另一个 QQ 号作为"主号"**：用来给小号发命令做测试。
- **若要测试群聊功能**：需要把主号和小号同时拉进同一个群，并知道这个群的群号。

> 小号建议设置：开启好友验证、关掉所有自动添加好友的设置、加好主号为好友。这样测起来安全。

---

## 1. 装依赖

```bash
cd /path/to/QQBot
pnpm install
```

完成后 `node_modules/` 应当出现，没有报错就行。

---

## 2. 改 QQBot 自己的配置

仓库里只提交了模板 `config/bot.example.json5`，运行用的 `config/bot.json5` 已 gitignored。第一次先复制一份：

```bash
cp config/bot.example.json5 config/bot.json5
```

然后编辑 `config/bot.json5`：

```json5
{
  // 反向 WS 监听地址。NapCat 会主动连过来。
  // listen.* 改完需要重启进程。
  listen: {
    host: "127.0.0.1",       // 单机部署填 127.0.0.1。如果 NapCat 在另一台机器，填 0.0.0.0
    port: 6700,              // 端口任选，6700 是 OneBot 圈子的"惯例"
    token: "change-me"       // ⚠️ 改成长随机串，下面解释
  },

  selfId: 10001,             // ⚠️ 改成你"小号"的 QQ 号
  allowedGroups: [],         // 群白名单。先留空，后面联通了再加
  allowedUsers: [],          // 私聊白名单。空数组 = 所有人都能私聊命令
  prefix: "/",               // 命令前缀，常见还有 "!"

  rateLimit: { perUser: 5, windowMs: 10000 },   // 每用户 10 秒最多 5 条命令
  commandsDir: "src/commands",
  log: { level: "info", dir: "logs" },

  // 可选: LLM 共享客户端，配了 /translate 和 /image 才能工作
  // llm: { ... }   // 见后面 §6
}
```

### 几个关键字段细说

**`listen.token`**——一定要改。这是 NapCat 跟 QQBot 之间握手的密钥。生成一个长随机串：

```bash
openssl rand -hex 16
```

把输出整段复制进去（带引号）。

**`selfId`**——填你**小号**的 QQ 号（数字，不带引号）。这个值只用来在群消息里判断"是不是 at 了我"，但启动时也会跟 NapCat 推过来的 self_id 做比对，对不上会有警告。

**`allowedGroups`**——空数组就是"任何群都不响应"。先留空，等私聊跑通了再加群号。一个常见误区是以为"我把 bot 拉进群了它就该响应"，**不会**——必须显式加进白名单。

**`allowedUsers`**——空数组在私聊场景下是"开放给任何加我好友的人"。如果你只想让自己的主号能用，就填 `[你主号的QQ]`。

**`prefix`**——一般保留 `/` 就行。

### 不要改但要知道的字段

- `commandsDir`：运行时扫的命令目录，相对仓库根。
- `log.dir`：JSON 日志写到这个子目录。空着的话只输出到 stdout。

---

## 3. 改 NapCat 这一侧的配置

打开 NapCat 的 WebUI（一般是 `http://127.0.0.1:6099` 之类，看你的 NapCat 实际监听端口）。

进入"OneBot 11" → 选你登录的小号那个 bot 实例 → 找到 **WebSocket Client（反向 WS）** 的设置：

- **启用**：开。
- **URL**：`ws://127.0.0.1:6700`（host 和 port 跟你刚填的 `listen.host:listen.port` 一致）。
- **Access Token**：填**跟 QQBot `listen.token` 一字不差**的同一个值。
- **重连间隔**：用默认就行（NapCat 自己会断线重连）。

保存。NapCat 会立刻尝试连过来。如果你这时还没启动 QQBot，它连不上是正常的，下一步启动它就会成功。

> 反向 WS 和正向 WS 的区别：反向 WS 是 NapCat 主动连 QQBot，断线 NapCat 重连；正向是 QQBot 主动连 NapCat，断线得 QQBot 重连。本项目只支持反向，因为反向断线恢复是 NapCat 已经实现好的，省一份代码。

---

## 4. 启动 QQBot

开发模式（带 watch + 美化日志）：

```bash
pnpm dev
```

或者一次性启动（不 watch）：

```bash
pnpm start
```

启动成功你应该按顺序看到这几行（dev 模式下被 pino-pretty 着色）：

```
reverse-ws listening { host: "127.0.0.1", port: 6700 }
commands loaded { commands: [ "help", "translate" ] }
qqbot ready { listen, selfId, allowedGroups, allowedUsers, prefix, commands }
client connected { uin: 你的小号QQ号, ua: "..." }
```

最后一行 `client connected` 出现就说明 NapCat 已经成功连上来了。如果一直只到 `qqbot ready` 没看到 `client connected`，回去检查 NapCat 那边的 WebSocket Client 配置（URL 和 token）。

---

## 5. 端到端冒烟测试（自动化）

跑一次自动化验收：

```bash
pnpm smoke
```

它会**启另一个临时端口的 bot 子进程**（不影响你刚启动的 dev 进程），自己扮演 NapCat 客户端，跑完 13 项验收用例，最后清理掉。期望输出：

```
✅ AC-14 bad token rejected — HTTP 401
✅ AC-2 private /help
✅ AC-3 private chitchat silent
... （略）
13/13 passed
```

如果这一步都过不了，说明你的代码或配置有问题，先解决了再去测真实 NapCat 联通。

---

## 6. 真实联通测试（手动）

### 6.1 私聊

用主号给小号发：

```
/help
```

期望小号自动回一条命令清单消息（至少有 `help` 和 `translate` 两行）。

如果没收到回复：

- 主号是不是已经加了小号好友？没加的话，QQ 自己就把消息拦截了。
- 主号 QQ 是不是 `allowedUsers` 白名单里？如果你设了非空白名单且没把主号加进去，bot 会安静地把消息丢掉。
- bot 进程的日志里有没有 `private dropped` 一行？有的话看 `reason` 字段。

### 6.2 群聊

1. 把主号和小号都拉进一个测试群，记下群号（不知道群号的话，可以让小号在群里随便发一句然后看 NapCat 日志，或者用 QQ 客户端 → 群资料里看）。
2. 编辑 `config/bot.json5`，把群号加到 `allowedGroups`：
   ```json5
   allowedGroups: [123456789]
   ```
3. **保存**——QQBot 会热加载这个变更，**不需要重启**。日志里应该出现 `config reloaded`。
4. 主号在群里发：
   ```
   @小号 /help
   ```
   注意 at 是 QQ 客户端的 at（点开成员选 at，不要手打 `@`）。

期望群里收到命令清单。

如果没回复：

- at 的是小号的 QQ 号吗？看消息源码里的 at 段 `qq` 字段。如果 at 错人了，bot 会安静丢弃。
- 群号在 `allowedGroups` 里吗？保存了吗？日志有没有 `config reloaded`？
- 命令前缀对吗？默认是 `/`，如果你改成了别的（如 `!`），那应当是 `@小号 !help`。

---

## 7.（可选）配置 LLM，让 `/translate` 和 `/image` 工作

`/translate` 默认无配置时会回："翻译功能未配置（管理员需在 bot.json5 设置 llm）"。`/image` 默认无配置时会回："生图功能未配置（管理员需在 bot.json5 设置 llm）"或"生图功能未配置（provider 缺 imageModel）"。要让两者工作，需要给一个 OpenAI 兼容的 API。

编辑 `config/bot.json5`，加上 `llm` 块：

```json5
{
  // ...其它字段...

  llm: {
    default: "openai",
    // imageDefault: "openai",   // 可选；不配则复用 default
    providers: {
      openai: {
        baseUrl: "https://api.openai.com/v1",
        apiKey:  "sk-你的真实key",
        model:   "gpt-4o-mini",        // chat: /translate 用；想翻图片需选支持视觉的
        imageModel: "gpt-image-1",     // image: /image 用；不填则 /image 不可用
        timeout: 30000
      },
      // 也可以同时配多家，按需切换 default / imageDefault
      // deepseek: {
      //   baseUrl: "https://api.deepseek.com/v1",
      //   apiKey:  "sk-...",
      //   model:   "deepseek-chat"
      // }
    }
  }
}
```

保存。LLM 配置也是热加载的，不用重启。

测试：

- 文本：私聊小号 `/translate Hello, how are you?` → 期望收到中文译文。
- 图片：私聊小号 `/translate` 时同时附一张含外文文字的图 → 期望收到图中文字的中文译文（**前提：用的 model 支持视觉**，比如 `gpt-4o-mini` / `qwen-vl-*`）。
- 文本+图片同时给：也支持，会一起翻。
- 生图：私聊小号 `/image a sparkling cat` → 期望收到一张图。`gpt-image-1` 默认返回 base64，会以 `base64://` 内联发回；`dall-e-3` 默认返回 URL（约 1 小时过期），优先选前者更稳。

> ⚠️ apiKey 是真金白银的密钥，不要 commit 进 git。`config/bot.json5` 已经默认在 `.gitignore` 之外，但**你应该把真实密钥保存在 `config/bot.json5.local` 之类的本地文件里**（已 gitignored），生产环境用环境变量或 secret 管理工具替换进去。

---

## 7.5（可选）启用 `/summary` 群聊总结

`/summary` 默认无配置时会回："总结功能未配置（管理员需在 bot.json5 设置 history）"。要让它工作，需要同时具备两件事：

1. 已经按 §7 配好 `cfg.llm`（`/summary` 用 chat 模型生成总结）。
2. 加上 `cfg.history` 块，把群聊消息按天滚动落到 JSONL 文件。

```json5
{
  // ...其它字段...
  llm: { /* 见 §7 */ },

  history: {
    dir: "data/history",            // 落盘目录，相对仓库根；data/ 已 gitignored
    retentionDays: 2,               // 保留 2 整天，过期文件每小时自动清理
    maxMessagesPerSummary: 1000     // 单次 /summary 最多喂给 LLM 多少条
  }
}
```

> ⚠️ **隐私与安全提醒**：这是项目里**唯一会把用户消息持久化到磁盘的地方**。开启前请确认：
>
> - 落盘目录在 `.gitignore` 范围内（默认 `data/` 已加入）。
> - 你接受这种"群里聊什么 → 文件里就有什么"的取舍。
> - 仅 `allowedGroups` 内的群消息会进缓冲；命令消息（at-self 或以 prefix 开头）自动排除。
> - 不想要了把 `cfg.history` 整块去掉、重启进程、并手动 `rm -rf data/history` 即可。

启用后的字段语义：
- `history.dir`：**改完需要重启**进程才会生效（启动时才会决定是否启用 writer）。
- `history.retentionDays`、`history.maxMessagesPerSummary`：保存即生效。

测试：
- 群里随意聊几句，然后 `@bot /summary` → 期望一份中文总结。留空区间 = 最近 1 小时。
- `@bot /summary 30m` / `@bot /summary 200`（按时长 / 按条数）。
- 同一群同时只允许一份总结生成中，再发会被回 `正在总结，请稍候…`。

---

## 8. 让它常驻——pm2 / launchd

### pm2

写一个 `ecosystem.config.cjs`（不要 commit）：

```js
module.exports = {
  apps: [{
    name: 'qqbot',
    script: 'node_modules/tsx/dist/cli.mjs',
    args: 'src/index.ts',
    env: { NODE_ENV: 'production' },
    max_memory_restart: '300M',
  }],
};
```

```bash
pm2 start ecosystem.config.cjs
pm2 logs qqbot           # 实时看日志
pm2 status               # 看运行状态
pm2 save && pm2 startup  # 开机自启（按提示执行）
```

### launchd（macOS）

写一个 plist 放到 `~/Library/LaunchAgents/com.you.qqbot.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.you.qqbot</string>
  <key>WorkingDirectory</key><string>/绝对路径/QQBot</string>
  <key>ProgramArguments</key>
  <array>
    <string>/绝对路径/node</string>
    <string>--import</string><string>tsx</string>
    <string>src/index.ts</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/绝对路径/QQBot/logs/launchd.out.log</string>
  <key>StandardErrorPath</key><string>/绝对路径/QQBot/logs/launchd.err.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.you.qqbot.plist
launchctl list | grep qqbot
```

### systemd（Linux）

写一个 service unit 放到 `/etc/systemd/system/qqbot.service`：

```ini
[Unit]
Description=QQBot
After=network-online.target

[Service]
WorkingDirectory=/绝对路径/QQBot
ExecStart=/绝对路径/node --import tsx src/index.ts
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now qqbot
journalctl -u qqbot -f
```

---

## 9. 常见排错

| 现象 | 多半是 | 怎么排查 |
|---|---|---|
| 启动后日志只到 `qqbot ready`，没有 `client connected` | NapCat 没连过来 | 看 NapCat 那边 WebSocket Client 配置：URL 对不对、token 对不对、是不是启用了。NapCat 自己日志里搜"reverse"或"websocket"看错误 |
| `ws upgrade rejected: bad token` | NapCat 那边的 access token 跟 `listen.token` 不一致 | 重新对一遍两边的 token，注意有没有空格、引号、回车等隐形字符 |
| `client connected` 出现了但 selfId 警告 | NapCat 登录的小号 QQ 号跟 `selfId` 字段对不上 | 检查 `bot.json5` 里 `selfId` 是不是写的小号，不是主号 |
| 主号私聊 `/help` 没回复 | 多种可能 | ① bot 日志里有没有 `private dropped`，看 `reason`。② `allowedUsers` 设了但没含主号。③ 主号没加小号好友导致消息根本没到 NapCat |
| 群里 `@bot /help` 没回复 | 群号没在白名单 | ① `allowedGroups` 加了群号没？保存了没？② 日志有没有 `group dropped`，看 `reason`（常见值：`not-allowed-group` / `no-at` / `no-prefix`） |
| 修改了配置文件没生效 | 改的字段是 restart-required 的 | `listen.host` / `listen.port` / `listen.token` 改完需要手动重启进程，看启动日志会有 `restart-required` 提示 |
| 命令文件存了没生效 | 文件没正确 export default | 确认 `src/commands/xxx.ts` 是 `export default` 一个对象，至少有 `name` / `description` / `handle` 三个字段 |
| `/translate` 回 "翻译功能未配置" | `cfg.llm` 没配 | 看本文 §7 |
| `/image` 回 "生图功能未配置（provider 缺 imageModel）" | provider 没设 `imageModel` | 在对应 provider 加 `imageModel: "gpt-image-1"` 之类，看 §7 |
| `/translate` 或 `/image` 回 "命令执行失败" | LLM API 端出错 | 看 bot 的 error 日志，里面有 `LlmError` 一行带 `code` 和 `httpStatus`。常见：401（key 错）、404（model 不存在）、422（model 不支持视觉但你给了图） |
| `/summary` 回 "总结功能未配置（管理员需在 bot.json5 设置 history）" | 没启用 `cfg.history` | 看本文 §7.5 |
| `/summary` 回 "总结功能未配置（管理员需在 bot.json5 设置 llm）" | 没配 `cfg.llm` | 看本文 §7 |
| `/summary` 回 "该时间段没有可总结的消息" | 缓冲里在该区间没东西 | 群是不是刚启用 `history`、还没攒下消息？只缓冲 `allowedGroups` 内的非命令消息，命令消息自动排除 |

如果排错过程里你怀疑是 trigger 逻辑或 router 的 bug，**不要改代码先**，先跑 `pnpm smoke` 看看是不是 13/13。如果 smoke 是绿的，那 bug 大概率在配置或 NapCat 侧。

---

## 10. 接下来想干什么？

- **想理解系统是怎么运转的**：读 [`ARCHITECTURE.md`](./ARCHITECTURE.md)，中文详解，覆盖架构、数据流、设计动机。读完之后再看代码会顺很多。
- **加新命令**：直接看 [`docs/plugins.md`](./docs/plugins.md)，里面有 `CommandHandler` 契约和最小示例。新增一个 `.ts` 文件就行，不用改主程序。
- **改配置 schema**：[`docs/config.md`](./docs/config.md) 是当前 schema 的权威描述。
- **想扩个底层能力**（比如加个 OCR、加个数据库支持）：先在 `docs/plans/` 下写一份提案讨论清楚，再让 AI 去实施。
- **看历史决策**：[`docs/archive/DESIGN.md`](./docs/archive/DESIGN.md) 是项目最初的整篇设计稿，已封存，但当时为什么这么选可以从那里翻出来。
