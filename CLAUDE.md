# QQBot

Command-only QQ bot, runs as a NapCatQQ (OneBot 11) reverse-WS client.

**Source of truth:** [`docs/DESIGN.md`](./docs/DESIGN.md). This file is operational guidance only — do not duplicate the design. If a change conflicts with DESIGN.md, surface it before coding.

## Boundaries

- This repo: `/Users/wang/Documents/Dev/IM/QQBot`.
- `../NapCatQQ/` is upstream — **read-only reference**, never modify.
- NapCat's `onebot11_<uin>.json` is user-managed via WebUI. Don't touch it.

## Stack (locked)

- TypeScript + Node ≥ 20, ESM, pnpm.
- No framework (NoneBot/Koishi forbidden), no DB, no HTTP callback, no Forward WS.
- Self-rolled `ws-server` + `ob11-client` + `zod`. Don't pull community OneBot libs.
- Single config file: `config/bot.json5` (hot-reload semantics in DESIGN.md §3.4).

## Expected layout

```
QQBot/
├── CLAUDE.md
├── README.md                ← user-facing: setup / run / add command / config
├── package.json
├── tsconfig.json
├── docs/DESIGN.md
├── config/bot.json5
├── src/
│   ├── index.ts             ← wire-up + start
│   ├── transport/
│   │   ├── ws-server.ts     ← reverse WS, token check, heartbeat
│   │   └── ob11-client.ts   ← API calls, echo correlation
│   ├── events/
│   │   ├── schema.ts        ← zod: MessageEvent / Segment union
│   │   └── parse.ts
│   ├── router/
│   │   ├── trigger.ts       ← private `/`, group at-self + `/`
│   │   ├── parse-cmd.ts     ← shell-like argv split
│   │   └── dispatch.ts      ← lookup + error guard + rate limit
│   ├── plugins/
│   │   ├── registry.ts      ← chokidar hot-reload of commands/
│   │   └── api.ts           ← CommandHandler / CommandContext
│   ├── config/
│   │   ├── schema.ts
│   │   └── loader.ts        ← reload + rollback on validation fail
│   └── commands/            ← one file per command
│       └── help.ts
└── logs/                    ← pino output, gitignored
```

Don't put files outside this tree without asking.

## Command contract

- Add `src/commands/xxx.ts`, `export default` a `CommandHandler` (DESIGN.md §3.5). Done.
- Never edit `src/index.ts` or `router/*` to register a command — that's AC-11.
- In handlers: use `ctx.reply` only (no direct client calls); don't throw past dispatch; no global state outside `ctx`.
- `description` and `usage` are mandatory (rendered by `/help`).

## Trigger rules (easy to break, test every time)

Anything not matching must be **fully silent** (debug log only, never info). See DESIGN.md §3.3.

- Private: `message_type==='private'` && first text segment starts with `cfg.prefix`.
- Group: `message_type==='group'` && `group_id ∈ cfg.allowedGroups` && segments contain `{type:'at', data:{qq: cfg.selfId}}` && first text **after stripping at** starts with `cfg.prefix`.
- Always re-run AC-3 / AC-6 / AC-7 / AC-8 after touching trigger logic.

## Logging & safety

- `pino` JSON; `pino-pretty` in dev.
- One structured line per trigger: `ts, source, userId, groupId?, cmd, argv.length, latencyMs, ok`.
- **Never log:** WS token, full message body, user content. Only `message_id` + `cmd` + metadata.
- Handler throw → dispatch catches → reply "命令执行失败", stack to error log, no internals leaked.

## Workflow

- Read the relevant DESIGN.md section before editing. Update README.md when user-facing behavior changes; update `config/schema.ts` + DESIGN.md §3.4 when config shape changes.
- New concept with no existing doc home → **ask the user** where it goes. Don't invent top-level docs.
- Style: edit over create; no speculative abstraction; validate at boundaries only; no comments unless the *why* is non-obvious.
- After each change, self-check the relevant AC cases in DESIGN.md §4.4. P0 cases (AC-1/2/3/5/6/7/8/11) must all pass. `pnpm smoke` runs an automated harness covering AC-2/3/4/5/6/7/8/9/10/11/12/13/14 against a freshly booted bot — re-run it after any change to transport, router, or plugin code.
- Commit only when asked. Never push unprompted.

## Current state

P0 + P1 scaffold landed: `transport/ws-server` (token check + heartbeat), `transport/ob11-client` (echo correlation), `events/` zod schemas, `router/` (trigger / parse-cmd / dispatch + token-bucket rate limit + handler error guard), `plugins/registry` (chokidar hot-reload via `?v=Date.now()` cache busting), `config/loader` (JSON5 + chokidar + rollback), `commands/help.ts`, `index.ts`, `README.md`. `pnpm typecheck` is clean.

Verified end-to-end against synthetic OB11 frames over the real reverse-WS: AC-1, AC-2, AC-3, AC-4, AC-5, AC-6, AC-7, AC-8, AC-9, AC-10, AC-11, AC-12, AC-13, AC-14. **Not yet verified** against a real NapCat: AC-15 (24h soak) and the round-trip over an actual NapCat reverse-WS client.

Contract delta from DESIGN.md §3.5: `CommandContext` now has `listCommands(): readonly CommandHandler[]` so the built-in `/help` doesn't reach into the registry directly. Reflected in `docs/DESIGN.md` §3.5.
