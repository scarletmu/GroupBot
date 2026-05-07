# Configuration

Single source of config: `config/bot.json5`. The committed template is `config/bot.example.json5`; `bot.json5` is gitignored and must be created by copying the example (`cp config/bot.example.json5 config/bot.json5`). Validated by zod (`src/config/schema.ts`). Loaded and watched by `src/config/loader.ts` — file changes are picked up by chokidar (debounce 100ms), reparsed, and on validation failure the previous config is kept.

## Schema

```json5
{
  // Reverse WS listen address. NapCat connects here.
  // Changing listen.* requires a process restart (loader emits 'restart-required').
  listen: { host: "127.0.0.1", port: 6700, token: "change-me" },

  // Bot's own QQ uin. Used for at-detection in groups.
  selfId: 10001,

  // Group whitelist. Only groups in this list will route commands when @bot.
  allowedGroups: [],

  // Private-chat user whitelist. Empty array = allow everyone.
  allowedUsers: [],

  // Trigger prefix. Default "/", can be any non-empty string.
  prefix: "/",

  // Per-user token bucket: perUser triggers per windowMs.
  rateLimit: { perUser: 5, windowMs: 10000 },

  // Command plugin directory (relative to repo root).
  commandsDir: "src/commands",

  // pino settings. dir adds a file sink in addition to stdout.
  log: { level: "info", dir: "logs" },

  // Optional: shared LLM client (OpenAI-compatible). See plugins.md.
  llm: {
    default: "openai",
    // imageDefault: "openai",   // optional; falls back to `default` for /image
    providers: {
      openai: {
        baseUrl: "https://api.openai.com/v1",
        apiKey:  "sk-...",
        model:   "gpt-4o-mini",         // chat (used by /translate)
        imageModel: "gpt-image-1",      // optional; required to enable /image
        timeout: 30000,
        // maxTokens: 1024,
        // headers: { ... }
      }
    }
  },

  // Optional: enables /summary by buffering group messages to JSONL. Off by default.
  // Only messages from `allowedGroups` are buffered; messages that look like
  // bot commands (at-self present or first text starts with `prefix`) are skipped.
  // history: {
  //   dir: "data/history",            // restart-required; created on first append
  //   retentionDays: 2,               // hot-reloadable
  //   maxMessagesPerSummary: 1000,    // hot-reloadable; cap fed into /summary's LLM call
  // }
}
```

`llm.default` and `llm.imageDefault` (when set) must reference a key in `llm.providers` — enforced by zod refine.

Enabling `history` is the only path that persists user content on disk. Treat it as a privacy-relevant decision: leave it off unless `/summary` is actually wanted, and review `cfg.history.dir` against your `.gitignore`.

## Hot-reload semantics

Take effect immediately on save:

- `allowedGroups`, `allowedUsers`, `prefix`, `rateLimit`, `log.level`, `llm.*`, `history.retentionDays`, `history.maxMessagesPerSummary`

Need a process restart (loader emits `restart-required`):

- `listen.host`, `listen.port`, `listen.token`

`commandsDir`, `selfId`, and the *presence* of `history` (along with `history.dir`) are read at startup; effectively restart-required. Toggling `history` on or off mid-run, or moving its directory, takes effect only on the next boot.

The loader keeps the previous valid config if a new save fails to parse or validate, and logs the issues. The bot keeps running with the old values.

## Acceptance touchpoints

- AC-9: prefix hot-swap.
- AC-10: group whitelist hot-reload.
- AC-14: bad token rejection (validates `listen.token` is enforced at WS upgrade).

See [acceptance.md](./acceptance.md).
