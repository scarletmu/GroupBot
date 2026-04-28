# Plugins (commands)

A command is one file in `src/commands/` that `export default`s a `CommandHandler`. The plugin registry watches this directory; saving a new or modified file hot-reloads it (no process restart). This is AC-11.

## CommandHandler

```ts
// src/plugins/api.ts
export interface CommandHandler {
  name: string;                            // matched against parsed cmd (lowercased)
  description: string;                     // rendered by /help
  usage?: string;                          // rendered by /help, e.g. "/echo <text>"
  scope?: 'private' | 'group' | 'both';    // default 'both'
  handle(ctx: CommandContext): Promise<void>;
}
```

Mandatory: `name`, `description`, `handle`. `usage` and `scope` are optional but `usage` is strongly recommended — it's what users see in `/help`.

## CommandContext

```ts
export interface CommandContext {
  event: PrivateMessageEvent | GroupMessageEvent;
  argv: string[];                          // shell-style tokens after the cmd name
  reply(content: string | Segment[]): Promise<void>;
  log: pino.Logger;                        // child logger, scoped { cmd }
  cfg: BotConfig;                          // live snapshot at trigger time
  listCommands(): readonly CommandHandler[];  // for /help; treat as read-only
  llm: LlmClient;                          // shared OpenAI-compatible client
}
```

- `ctx.reply` routes to private or group automatically based on `event.message_type`.
- `ctx.cfg` is the live config snapshot at the moment the trigger fired. If the user edits the config mid-handler, you keep your snapshot — that's intentional.
- Throwing inside `handle` is fine. Dispatch catches, replies `命令执行失败`, logs the stack at error level. The process keeps running (AC-13).
- No global state outside `ctx`. If a handler needs persistence, that's a scope expansion — discuss before adding.

## Adding a command

```ts
// src/commands/echo.ts
import type { CommandHandler } from '../plugins/api.js';

const echo: CommandHandler = {
  name: 'echo',
  description: 'echo back the arguments',
  usage: '/echo <text>',
  scope: 'both',
  async handle(ctx) {
    await ctx.reply(ctx.argv.join(' ') || '(empty)');
  },
};

export default echo;
```

Save the file. The registry hot-reloads it (uses dynamic `import()` with `?v=Date.now()` to bust ESM cache). Try `/echo hello` immediately — no restart.

**Don't ever edit `src/index.ts` or `src/router/*` to register a command.** That's the contract — adding a file should be sufficient. It's also AC-11.

## LLM shared client

`ctx.llm.chat(...)` is available to every handler. It calls an OpenAI-compatible `/chat/completions` endpoint. Bot stays strictly command-driven: handlers decide whether and how to reach an LLM. No `/ask` or `/chat` style commands — see [architecture.md](./architecture.md#locked-decisions--out-of-scope).

### Contract

```ts
// src/llm/api.ts
type ChatRole = 'system' | 'user' | 'assistant';
type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low'|'high'|'auto' } };

interface ChatMessage { role: ChatRole; content: string | ContentPart[]; }
interface ChatRequest {
  messages: ChatMessage[];
  provider?: string;        // default cfg.llm.default
  model?: string;           // overrides provider.model
  temperature?: number;
  topP?: number;
  maxTokens?: number;       // overrides provider.maxTokens
  signal?: AbortSignal;
}
interface ChatResponse {
  content: string;
  model: string;
  provider: string;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  finishReason?: string;
}
class LlmError extends Error {
  code: 'NOT_CONFIGURED' | 'PROVIDER_NOT_FOUND' | 'TIMEOUT' | 'HTTP' | 'PARSE' | 'NETWORK';
  httpStatus?: number;
}
```

`chat()` always throws `LlmError` on failure. Catch it if you want a friendlier per-handler message; otherwise let it bubble and dispatch will reply `命令执行失败`.

### Configuring providers

In `config/bot.json5`:

```json5
llm: {
  default: "openai",
  providers: {
    openai: {
      baseUrl: "https://api.openai.com/v1",
      apiKey:  "sk-...",
      model:   "gpt-4o-mini",
      timeout: 30000,
    },
    deepseek: {
      baseUrl: "https://api.deepseek.com/v1",
      apiKey:  "sk-...",
      model:   "deepseek-chat",
    },
  },
}
```

Hot-reloadable: changing providers / default takes effect on the next call (the client reads `cfg().llm` per request).

### Minimal handler example

```ts
import type { CommandHandler } from '../plugins/api.js';

const summarize: CommandHandler = {
  name: 'summarize',
  description: '一句话中文概括',
  usage: '/summarize <text>',
  async handle(ctx) {
    const r = await ctx.llm.chat({
      messages: [
        { role: 'system', content: '用一句中文概括用户输入。仅输出概括。' },
        { role: 'user', content: ctx.argv.join(' ') },
      ],
    });
    await ctx.reply(r.content);
  },
};
export default summarize;
```

### Multimodal (vision)

Pass parts:

```ts
content: [
  { type: 'text', text: '描述这张图。' },
  { type: 'image_url', image_url: { url: 'https://...' } },
]
```

The configured provider/model must support vision. Built-in `/translate` is the reference example — extracts `image` segments from `ctx.event.message`, builds a multimodal user message.

### Logging rules (strict)

The client logs one info line per successful call: `{ provider, model, latencyMs, msgCount, promptTokens, completionTokens, finishReason }`. Failures: warn level with `code` + `httpStatus`. **Never** log `messages` content, response text, image URLs, or `apiKey`. HTTP error body snippets stay at debug level (≤500 bytes), in case the upstream echoes credentials.

If you write your own LLM-using handler, follow the same rule: log shape, not substance.

## Built-in commands

- **`/help`** — list registered commands (name + usage + description).
- **`/translate <text>`** — translate text to Chinese via the configured LLM.
- **`/translate`** (with image segments attached) — translate text content of those images to Chinese (requires a vision-capable model). Combined `/translate <text>` + image is also supported.

`/translate` requires `cfg.llm`; otherwise it replies `翻译功能未配置（管理员需在 bot.json5 设置 llm）`.
