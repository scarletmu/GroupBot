# QQBot — agent guide

Command-only QQ bot, runs as a NapCatQQ (OneBot 11) reverse-WS client. This file is your index. Read only the relevant doc — don't sweep the tree.

## Boundaries

- This repo: `/Users/wang/Documents/Dev/IM/QQBot`.
- `../NapCatQQ/` is upstream — **read-only reference**, never modify.
- NapCat's `onebot11_<uin>.json` is user-managed via WebUI. Don't touch it.
- Commit only when asked. Never push unprompted.

## Doc tiers

Documents in this repo are split into three tiers. **Only Tier 1 is for you.** The others exist for humans or as frozen history; do not read them on your own.

### Tier 1 — for the agent (read these)

English, terse, kept current. Pick the right one from the table below and read only that.

| If you're about to … | Read |
|---|---|
| Touch `transport/`, `events/`, `router/`, `plugins/registry`, or change data flow | [docs/architecture.md](./docs/architecture.md) |
| Touch trigger logic in `router/trigger.ts` | [docs/architecture.md#trigger-rules](./docs/architecture.md#trigger-rules) — then run `pnpm smoke` |
| Change `config/bot.json5` shape, hot-reload semantics, or `src/config/schema.ts` | [docs/config.md](./docs/config.md) |
| Add a command, change `CommandHandler` / `CommandContext`, or use `ctx.llm` | [docs/plugins.md](./docs/plugins.md) |
| Change behavior covered by AC-1…AC-15, or update the smoke harness | [docs/acceptance.md](./docs/acceptance.md) |

When you change a contract or config shape, update the matching Tier-1 doc in the same change.

### Tier 2 — for humans (do not read on your own)

Chinese, detailed, written for the operator/maintainer. **Don't open these proactively.** If the user's request is about installing, running, browsing the project, or drafting a feature proposal, point them at the file instead of reading it yourself. Read only if the user explicitly directs you to.

- `README.md` — 项目简介，给浏览仓库的人看的。
- `QUICKSTART.md` — 上手手册，给运维/部署者看的。
- `ARCHITECTURE.md` — 中文版架构详解，写给想理解系统怎么运转的人。和 `docs/architecture.md` 覆盖同样事实但更长更"为什么"。**你需要的事实在 `docs/architecture.md` 里，别读这份。**
- `docs/plans/` — 给人类起草新功能提案的目录；用户决定要建时再让你看具体某个文件。

### Tier 3 — archive (do not read)

`docs/archive/` 是冻结历史。Nobody reads it during normal work — not you, not the user. It exists so prior decisions and session logs aren't lost. Only touch it if the user explicitly asks "look up the original X", and even then read only the named file.

## Hard rules (don't break)

- **Trigger silence:** anything not matching the rules in `architecture.md#trigger-rules` is fully silent (debug log only, never info). Re-run AC-3 / AC-6 / AC-7 / AC-8 after touching trigger logic. `pnpm smoke` covers them.
- **Add commands by file only:** never edit `src/index.ts` or `src/router/*` to register a command. That's AC-11.
- **No direct user↔LLM dialogue:** the bot is `/<cmd>`-driven. LLM is plumbing for handler authors via `ctx.llm`. No `/ask`, no `/chat`. Bounded tool commands like `/translate` are fine.
- **Logging:** never log WS token, full message body, user content, `apiKey`, or image URLs. LLM info logs carry only `{ provider, model, latencyMs, msgCount, tokens, finishReason }`. Handler errors → `命令执行失败` to the user, stack to error log, no internals leaked.
- **Stack is locked:** no NoneBot/Koishi/openai-SDK/axios. See `architecture.md#locked-decisions--out-of-scope`.

## Workflow

- Pick the right Tier-1 doc, read only that section, then edit.
- After any change to `transport/` / `router/` / `plugins/` / `config/` / `events/`: `pnpm typecheck` and `pnpm smoke` (expect 13/13).
- New concept with no existing Tier-1 home → ask the user where it goes; don't invent a new top-level doc.
- Style: edit over create; no speculative abstraction; validate at boundaries only; comments only when the *why* is non-obvious.
- If you find Tier-1 and code disagree, surface it before silently diverging.

## Current state

P0+P1 plus LLM shared client are landed. Verified via `pnpm smoke` (13/13) and synthetic OB11 frames; AC-15 (24h soak) and full round-trip against a real NapCat client are not yet automated.

Active commands: `/help`, `/translate` (text + multimodal, requires `cfg.llm`).

`CommandContext` surface: `event`, `argv`, `reply`, `log`, `cfg`, `listCommands()`, `llm`.
