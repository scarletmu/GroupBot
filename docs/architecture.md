# Architecture

## Topology

```
┌────────────────┐   reverse WS    ┌────────────────────┐
│  NapCatQQ      │ ──────────────▶ │  QQBot              │
│  (NTQQ host)   │ ◀────────────── │  ws://0.0.0.0:6700  │
└────────────────┘   API + events  └────────────────────┘
       ▲                                     │
       │ QR login                            │ loads
   小号 QQ                              config/bot.json5
                                       src/commands/*.ts
```

NapCat is the OneBot 11 adapter on top of NTQQ. We don't reimplement QQ protocol — QQBot is purely an OB11 client + command router + file-based plugin loader. NapCat dials into us (reverse WS); we accept one connection at a time, validate `Authorization: Bearer <token>`, and exchange events / API calls over that single socket.

## Module layout

```
src/
├── index.ts                ← wire-up + start
├── transport/
│   ├── ws-server.ts        ← reverse WS, token check, heartbeat
│   └── ob11-client.ts      ← API calls (send_*_msg), echo correlation, 10s timeout
├── events/
│   ├── schema.ts           ← zod: MessageEvent / Segment union
│   └── parse.ts            ← raw JSON → typed event
├── router/
│   ├── trigger.ts          ← private `/`, group at-self + `/`
│   ├── parse-cmd.ts        ← shell-like argv split (string-argv)
│   └── dispatch.ts         ← lookup + error guard + token-bucket rate limit
├── plugins/
│   ├── api.ts              ← CommandHandler / CommandContext contract
│   └── registry.ts         ← chokidar hot-reload of commands/, ?v=Date.now() cache bust
├── config/
│   ├── schema.ts           ← BotConfig zod schema
│   └── loader.ts           ← JSON5 + chokidar + rollback on validation fail
├── llm/
│   ├── api.ts              ← shared LLM types + LlmError + LlmClient interface
│   └── client.ts           ← createLlmClient: built-in fetch, OpenAI-compatible
└── commands/               ← one file per command, hot-reloaded
    ├── help.ts
    └── translate.ts
```

`logs/` is gitignored, written by `pino` when `cfg.log.dir` is set. `scripts/smoke.mjs` is the AC harness; not part of the runtime.

## End-to-end data flow

1. NapCat connects to `ws://<listen.host>:<listen.port>`. `ws-server.ts` checks `Authorization: Bearer <token>`. Bad token → HTTP 401, drop. Good token → upgrade, start 30s heartbeat.
2. NapCat pushes event JSON. `events/parse.ts` runs zod and tags the frame as `private | group | meta | notice | request | api-response | unknown | invalid`. Non-message frames go to debug log; `api-response` is routed back to `ob11-client.ts` via `echo` correlation.
3. `router/trigger.ts` decides whether the message triggers (see [Trigger rules](#trigger-rules) below). Untriggered → debug log only, **never** info.
4. `router/parse-cmd.ts` extracts `cmd` (lowercased) and `argv` (shell-style, supports `"quoted"`).
5. `router/dispatch.ts`:
   - Per-user token bucket (default 5 / 10s). First overflow → reply `操作过于频繁`, then silent until window expires.
   - Lookup in `plugins/registry`. Miss → reply `未知命令，<prefix>help 查看`. Hit → run handler with `CommandContext`.
   - Handler throws → catch, reply `命令执行失败`, log stack at error level. Process never crashes from handler errors.
6. Handler calls `ctx.reply(...)` → `ob11-client.sendPrivateMsg` / `sendGroupMsg` → OB11 `send_*_msg` over the WS, correlated by `echo`.

One structured log line per trigger: `{ source, userId, groupId?, cmd, argvLen, latencyMs, ok, mid }`. Never log full message body, user content, or token.

## Trigger rules

The bot replies in **only** these two cases. Everything else is silent (debug log only).

- **Private:** `message_type === 'private'` AND first text segment starts with `cfg.prefix`.
- **Group:** `message_type === 'group'` AND `group_id ∈ cfg.allowedGroups` AND segments contain `{ type: 'at', data: { qq: cfg.selfId } }` AND, after stripping `reply` + `at` + adjacent whitespace, the first remaining text starts with `cfg.prefix`.

The strip order in `router/trigger.ts::stripLeadingAtAndReply`:
1. Drop leading `reply` segment (QQ clients prepend it on quoted replies).
2. Drop the first `at` segment with `qq === selfId`.
3. Drop whitespace-only text segments adjacent to the at.
4. `replace(/^\s+/, '')` on the new first text segment.

Whenever you touch trigger logic, re-run AC-3 / AC-6 / AC-7 / AC-8 (see [acceptance.md](./acceptance.md)). `pnpm smoke` covers all four.

## Locked decisions / out of scope

These are intentional and pre-commit guardrails. Don't undo without an explicit conversation.

**Locked stack**

- TypeScript + Node ≥ 20, ESM, pnpm.
- Self-rolled `ws-server` + `ob11-client` + `zod`. No NoneBot2, no Koishi, no community OneBot libs.
- Reverse WebSocket only. No HTTP callback, no Forward WS.
- Single config file: `config/bot.json5`. No env-var sprawl.
- No database. Handlers are stateless; if one needs persistence, that's a deliberate scope expansion.
- LLM access via built-in `fetch` + `AbortController` against OpenAI-compatible endpoints. No `openai` SDK, no `axios`.

**Out of scope**

- Active push, scheduled jobs, subscriptions.
- Multi-account / multi-instance.
- Web UI / remote admin panel.
- Persistent command state.
- Rich-media uplink (OCR, voice transcription, etc. — except via LLM multimodal calls handlers initiate themselves).
- Direct user↔LLM dialogue. The bot is strictly `/<cmd>`-driven; LLM is a tool handlers reach for, not a chat surface. No `/ask`, no `/chat`. See [plugins.md](./plugins.md#llm-shared-client) for the contract.

## Logging & safety

- `pino` JSON in production, `pino-pretty` in dev.
- One info line per trigger. Errors at error level with stack. LLM HTTP body snippets only at debug.
- **Never log:** WS token, full message body, user content, `apiKey`, image URLs (treat them as user content).
- LLM call info logs: `{ provider, model, latencyMs, msgCount, promptTokens, completionTokens, finishReason }` only.
- Handler throw → dispatch catches → user sees `命令执行失败`, no internal details.
