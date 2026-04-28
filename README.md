# QQBot

Command-only personal QQ bot. Connects to [NapCatQQ](https://github.com/NapNeko/NapCatQQ) over reverse WebSocket (OneBot 11), routes `/<cmd>` messages to file-based handlers, ignores everything else.

Design contract: [`docs/DESIGN.md`](./docs/DESIGN.md). Operational rules: [`CLAUDE.md`](./CLAUDE.md).

## Setup

Prerequisites: Node ≥ 20, pnpm, NapCatQQ already running and logged in with the small-account.

```bash
pnpm install
cp config/bot.json5 config/bot.json5.local   # optional backup
$EDITOR config/bot.json5
```

Edit `config/bot.json5`:

- `listen.token` — set to a long random string. Must match NapCat's `accessToken`.
- `listen.host` / `listen.port` — where NapCat connects (default `127.0.0.1:6700`).
- `selfId` — the bot account's QQ uin. Used for at-detection in groups.
- `allowedGroups` — group IDs that may invoke commands via `@bot /xxx`. Empty = no group is allowed.
- `allowedUsers` — private-chat user whitelist. Empty = open to everyone.
- `prefix` — command prefix, default `/`.

## Configure NapCat side

In NapCat WebUI → OneBot 11 adapter for the bot account, enable a **WebSocket client** (reverse-WS, NapCat dials out):

- URL: `ws://127.0.0.1:6700`
- Access token: same value as `listen.token` above.

Save and reload NapCat's adapter.

## Run

```bash
pnpm dev      # tsx watch, pretty logs
pnpm start    # one-shot tsx
pnpm smoke    # AC harness — boots a temp instance, runs §4.4 cases, tears down
```

You should see, in order:

```
reverse-ws listening { host, port }
commands loaded { commands: [ 'help' ] }
qqbot ready { ... }
client connected { uin, ua }
```

## Add a command

One file in `src/commands/` per command. No edits to `index.ts` or `router/*` — that's the contract.

```ts
// src/commands/echo.ts
import type { CommandHandler } from '../plugins/api.js';

const echo: CommandHandler = {
  name: 'echo',
  description: 'echo back the arguments',
  usage: '/echo <text>',
  scope: 'both', // 'private' | 'group' | 'both' (default 'both')
  async handle(ctx) {
    await ctx.reply(ctx.argv.join(' ') || '(empty)');
  },
};

export default echo;
```

Save the file. The registry hot-reloads it (no restart). Try `/echo hello`.

Inside `handle(ctx)` you get:

- `ctx.event` — the parsed `PrivateMessageEvent | GroupMessageEvent`.
- `ctx.argv` — shell-style tokens after the command name (supports `"quoted strings"`).
- `ctx.reply(content)` — reply with a string or OneBot segment array. Routes to private or group automatically.
- `ctx.cfg` — current `BotConfig` snapshot.
- `ctx.log` — per-command `pino` logger.
- `ctx.listCommands()` — used by `/help`; safe to ignore otherwise.

Throwing inside `handle` is fine — dispatch catches it, replies "命令执行失败", logs the stack. The process keeps running.

## Hot-reload semantics

`config/bot.json5` changes apply immediately for:

- `allowedGroups`, `allowedUsers`, `prefix`, `rateLimit`, `log.level`

Changes to `listen.host`, `listen.port`, or `listen.token` require a process restart. The log will warn when one is needed.

## Trigger rules (intentional, do not weaken)

The bot replies in **only** these two cases:

- **Private chat:** `message_type === 'private'` and the first text segment starts with `prefix`.
- **Group:** the group is in `allowedGroups`, the message contains `{type:'at', data:{qq: selfId}}`, and after stripping the at, the first remaining text starts with `prefix`.

Anything else (普通聊天, only-at, only-prefix in group, non-whitelisted group) is silently ignored. Nothing is sent. Acceptance cases AC-3, AC-6, AC-7, AC-8 in `docs/DESIGN.md §4.4` cover this.

## Logging

`pino` JSON in production, `pino-pretty` in dev. Each successful command logs one structured line with `source / userId / groupId? / cmd / argvLen / latencyMs / ok / mid`. Token, full message body, and user content are never logged.

If `log.dir` is set in config, logs are also appended to `<dir>/bot.log`.

## Process management

Recommended pm2 entry (not committed — write your own `ecosystem.config.cjs`):

```js
module.exports = {
  apps: [{
    name: 'qqbot',
    script: 'node_modules/tsx/dist/cli.mjs',
    args: 'src/index.ts',
    env: { NODE_ENV: 'production' },
  }],
};
```

`launchd` works equally well — run `pnpm start` from a `KeepAlive=true` plist.

## Troubleshooting

- **NapCat connects but nothing happens** → verify `selfId` matches the QQ account NapCat is logged into. The boot log warns on uin mismatch.
- **`@bot /help` in a group is silent** → group ID isn't in `allowedGroups`. Check `config/bot.json5`.
- **Token errors** → bot logs `ws upgrade rejected: bad token` with the peer addr. The two `accessToken` values must match exactly.
- **Command file edits don't take effect** → confirm the file `export default`s a `CommandHandler` with at least `name`, `description`, and `handle`.
