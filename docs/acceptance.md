# Acceptance criteria

The cases the bot must pass. ✅ = should reply, 🚫 = should not reply.

## Functional (AC-1 .. AC-14)

| # | Scenario | Action | Expected | Smoke |
|---|---|---|---|---|
| AC-1  | Reverse WS connect | NapCat dials `ws://127.0.0.1:6700` | bot logs `client connected uin=…`; NapCat side shows connected | implicit (smoke connect must succeed) |
| AC-2  | Private positive | Send `/help` to bot in private | ✅ command list; `／help` also works when `prefix` is `/` | ✅ |
| AC-3  | Private chitchat | Send `你好` in private | 🚫 fully silent (debug log only) | ✅ |
| AC-4  | Unknown command | Send `/foo` in private | ✅ `未知命令，/help 查看` | ✅ |
| AC-5  | Group at + cmd | In whitelisted group: `@bot /help` | ✅ command list in group; `@bot ／help` also works when `prefix` is `/` | ✅ |
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

`scripts/smoke.mjs` runs the functional smoke cases against a freshly booted bot:

1. Writes a temp `bot.json5` (random port, random token).
2. Spawns `node --import tsx src/index.ts`, waits for `qqbot ready`.
3. Plays NapCat as a reverse WS client, runs the cases sequentially.
4. Tears down: SIGTERM bot, removes temp config and any `src/commands/_smoke_*.ts` written during the run.

Run it after any change to `transport/`, `router/`, `plugins/`, `config/`, or `events/`:

```bash
pnpm smoke   # expect: 13/13 passed
```

Cases not covered by smoke: AC-1 round-trip with a real NapCat (smoke uses synthetic frames), AC-15 (long soak).

## What `/translate`, `/image`, and `/summary` do *not* count toward

None of these are in the AC table — all three depend on an external LLM API and aren't reproducible in CI-style smoke runs. Treat them as manual feature tests.

### `/translate`

1. Configure a real provider in `cfg.llm`.
2. Private `/translate Hello, how are you?` → expect immediate `已收到，正在翻译，请稍候…`, then Chinese reply.
3. Private `/translate` with an image of foreign-language text → expect immediate confirmation, then Chinese reply (the configured chat model must support vision). The bot fetches the image locally and sends an in-memory `data:` URL to the LLM; if local fetch fails, expect `图片读取失败，请稍后再试`. If the LLM request itself times out, expect `翻译请求超时，请稍后再试`.
4. Group quoted message + `@bot /translate` → expect immediate confirmation, then Chinese translation of the quoted message text/image. The final translation message starts with a `reply` segment referencing the quoted message ID and must not include an `at` segment for the quoted message's original sender.
5. With `cfg.llm` removed → expect `翻译功能未配置（管理员需在 bot.json5 设置 llm）`.
6. With wrong `apiKey` → expect `命令执行失败`, error log shows `LlmError('HTTP', ..., 401)`, **no** apiKey in any log.

### `/image`

1. Configure a provider with `imageModel` (e.g. `gpt-image-1`) in `cfg.llm`.
2. Private `/image a sparkling cat` → expect immediate `已收到，正在生成图片，请稍候…`, then an image reply. Info log: one line `llm image ok` with `{ provider, model, latencyMs, n, hasB64, hasUrl }` — **no** prompt, **no** b64, **no** url.
3. Empty argv `/image` → expect `用法：/image <描述>`, no LLM call.
4. With `cfg.llm` removed → expect `生图功能未配置（管理员需在 bot.json5 设置 llm）`.
5. With provider missing `imageModel` → expect `生图功能未配置（provider 缺 imageModel）`.
6. With wrong `apiKey` → expect `命令执行失败`, error log shows `LlmError('HTTP', ..., 401)`, **no** apiKey / b64 / url in any log.
7. Hot-reload: change `imageModel` while the bot is running → next `/image` uses the new model without restart.
8. Per-user concurrency cap: send `/image cat`, then within ~1s send `/image dog` from the **same** QQ user (private or any whitelisted group) → second call replies `正在生成图片，请稍候…` and does **not** hit the LLM. After the first call resolves (or errors out), `/image dog` works normally. A different QQ user firing `/image` during the same window is unaffected.
9. If the final `send_private_msg` / `send_group_msg` API call times out waiting for NapCat's echo but the image is delivered anyway → expect no extra `命令执行失败`; warn log only, with no prompt / b64 / url.

### `/summary`

1. Configure both `cfg.llm` and `cfg.history`. In a whitelisted group, send 5–10 ordinary messages (text + image + at).
2. `@bot /summary` (no arg) → expect a Chinese summary covering the last 1h. The LLM input format includes `[HH:MM] 昵称: 文本` per line, with `[图片]` placeholders for images and `@昵称` placeholders for at-segments.
3. `@bot /summary 30m` → restricts to the last 30 minutes.
4. `@bot /summary 200` (bare integer) → last 200 messages instead of duration.
5. `@bot /summary 99h99m` (no clear meaning past 24h, but format is valid) → still parses; if no history exists in that range, replies `该时间段没有可总结的消息`.
6. `@bot /summary abc` → replies `用法：/summary [1h|30m|200]`.
7. With `cfg.history` removed → expect `总结功能未配置（管理员需在 bot.json5 设置 history）`.
8. With `cfg.llm` removed → expect `总结功能未配置（管理员需在 bot.json5 设置 llm）` (only after history check passes).
9. Send `/summary` in private chat → expect `总结功能仅在群聊中可用`.
10. In a non-whitelisted group, send `@bot /summary` → silent (group whitelist gate fires before the handler), and the message itself is **not** buffered.
11. Per-group concurrency cap: in the same group, fire two `/summary` calls within ~1s → second replies `正在总结，请稍候…` and does **not** hit the LLM. Two `/summary` in *different* groups simultaneously both proceed.
12. Privacy spot-check: with `cfg.history` unset, no `data/history/` directory is created and no JSONL files appear, even after group traffic. With it set, command-shaped messages (at-self, or first text starts with `prefix`) are excluded from the JSONL.
13. Retention: after letting the bot run across midnight, day-old files are kept; files older than `retentionDays` are deleted by the hourly cleanup tick (or at next startup).
