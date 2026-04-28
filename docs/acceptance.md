# Acceptance criteria

The cases the bot must pass. ✅ = should reply, 🚫 = should not reply.

## Functional (AC-1 .. AC-14)

| # | Scenario | Action | Expected | Smoke |
|---|---|---|---|---|
| AC-1  | Reverse WS connect | NapCat dials `ws://127.0.0.1:6700` | bot logs `client connected uin=…`; NapCat side shows connected | implicit (smoke connect must succeed) |
| AC-2  | Private positive | Send `/help` to bot in private | ✅ command list | ✅ |
| AC-3  | Private chitchat | Send `你好` in private | 🚫 fully silent (debug log only) | ✅ |
| AC-4  | Unknown command | Send `/foo` in private | ✅ `未知命令，/help 查看` | ✅ |
| AC-5  | Group at + cmd | In whitelisted group: `@bot /help` | ✅ command list in group | ✅ |
| AC-6  | Group at-only | In whitelisted group: `@bot 在吗` | 🚫 silent | ✅ |
| AC-7  | Group cmd no at | In whitelisted group: `/help` (no at) | 🚫 silent | ✅ |
| AC-8  | Non-whitelisted group | Group not in `allowedGroups`: `@bot /help` | 🚫 silent | ✅ |
| AC-9  | Prefix hot-swap | Change `prefix` `/`→`!`, save, send `!help` | ✅ matches; `/help` no longer matches | ✅ |
| AC-10 | Group whitelist hot-reload | Remove a group ID, save, send `@bot /help` there | 🚫 silent, no restart | ✅ |
| AC-11 | Add a command | Drop `src/commands/ping.ts`, save | `/ping` matches without restart | ✅ |
| AC-12 | Rate limit | Burst 6× `/help` in 1s | first 5 ✅, 6th `操作过于频繁` once, then silent for the window | ✅ |
| AC-13 | Handler isolation | Throw inside a handler | ✅ `命令执行失败`, process survives, stack to error log | ✅ |
| AC-14 | Bad token | NapCat connects with wrong token | bot rejects WS upgrade with HTTP 401, logs peer addr | ✅ |

## Non-functional

| ID | Target | Status |
|---|---|---|
| AC-15 | 24h soak with one NapCat restart mid-run | not yet automated; needs pm2/launchd run |
| Latency | event → send API call ≤ 100ms on loopback | informally OK, no regression test |
| Memory | 7-day RSS growth < 50 MB | unverified |
| Safety | WS token enforced; handler throw doesn't crash; no token / message body / user content in info logs | enforced; spot-checked |

## smoke harness

`scripts/smoke.mjs` runs 13/14 of the functional cases against a freshly booted bot:

1. Writes a temp `bot.json5` (random port, random token).
2. Spawns `node --import tsx src/index.ts`, waits for `qqbot ready`.
3. Plays NapCat as a reverse WS client, runs the cases sequentially.
4. Tears down: SIGTERM bot, removes temp config and any `src/commands/_smoke_*.ts` written during the run.

Run it after any change to `transport/`, `router/`, `plugins/`, `config/`, or `events/`:

```bash
pnpm smoke   # expect: 13/13 passed
```

Cases not covered by smoke: AC-1 round-trip with a real NapCat (smoke uses synthetic frames), AC-15 (long soak).

## What `/translate` does *not* count toward

`/translate` is not in the AC table — it depends on an external LLM API and isn't reproducible in CI-style smoke runs. Treat it as a manual feature test:

1. Configure a real provider in `cfg.llm`.
2. Private `/translate Hello, how are you?` → expect Chinese reply.
3. Private `/translate` with an image of foreign-language text → expect Chinese reply (provider/model must support vision).
4. With `cfg.llm` removed → expect `翻译功能未配置（管理员需在 bot.json5 设置 llm）`.
5. With wrong `apiKey` → expect `命令执行失败`, error log shows `LlmError('HTTP', ..., 401)`, **no** apiKey in any log.
