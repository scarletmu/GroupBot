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
  history?: HistoryReader;                 // present only when cfg.history is set
}

interface HistoryReader {
  recent(args: {
    groupId: number;
    sinceMs?: number;
    lastN?: number;
    capMessages: number;
  }): Promise<HistoryRecord[]>;            // see src/history/store.ts for HistoryRecord
}
```

- `ctx.reply` routes to private or group automatically based on `event.message_type`.
- `ctx.cfg` is the live config snapshot at the moment the trigger fired. If the user edits the config mid-handler, you keep your snapshot — that's intentional.
- Throwing inside `handle` is fine. Dispatch catches, replies `命令执行失败`, logs the stack at error level. The process keeps running (AC-13).
- `ctx.history` is `undefined` when `cfg.history` is not configured. Built-in `/summary` is currently the only consumer; if you add another handler that depends on it, replicate the friendly "未配置" reply path rather than throwing.
- No global state outside `ctx`. If a handler needs persistence beyond what `ctx.history` already provides, that's a scope expansion — discuss before adding.

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

`ctx.llm.chat(...)` and `ctx.llm.image(...)` are available to every handler. They call OpenAI-compatible `/chat/completions` and `/images/generations` endpoints. Bot stays strictly command-driven: handlers decide whether and how to reach an LLM. No `/ask` or `/chat` style commands — see [architecture.md](./architecture.md#locked-decisions--out-of-scope).

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

interface ImageRequest {
  prompt: string;
  provider?: string;        // default cfg.llm.imageDefault ?? cfg.llm.default
  model?: string;           // overrides provider.imageModel
  size?: string;            // e.g. "1024x1024"; passed through
  n?: number;               // default 1
  signal?: AbortSignal;
}
interface ImageItem { b64?: string; url?: string; }   // at least one set
interface ImageResponse {
  images: ImageItem[];
  model: string;
  provider: string;
}

class LlmError extends Error {
  code: 'NOT_CONFIGURED' | 'PROVIDER_NOT_FOUND' | 'NO_IMAGE_MODEL' | 'TIMEOUT' | 'HTTP' | 'PARSE' | 'NETWORK';
  httpStatus?: number;
}
```

`chat()` and `image()` always throw `LlmError` on failure. Catch it if you want a friendlier per-handler message; otherwise let it bubble and dispatch will reply `命令执行失败`.

`image()` does not pass `response_format` to the upstream — `gpt-image-1` returns `b64_json` by default, `dall-e-3` returns `url`. Parse `images[i].b64` first, fall back to `images[i].url`. Treat URLs as short-lived (OpenAI image URLs expire ~1h).

### Configuring providers

In `config/bot.json5`:

```json5
llm: {
  default: "openai",
  // imageDefault: "openai",   // optional; falls back to `default`
  providers: {
    openai: {
      baseUrl: "https://api.openai.com/v1",
      apiKey:  "sk-...",
      model:   "gpt-4o-mini",       // chat
      imageModel: "gpt-image-1",    // optional; required to enable /image
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

Hot-reloadable: changing providers / default / imageDefault takes effect on the next call (the client reads `cfg().llm` per request).

`imageModel` is per-provider. If the provider used by `image()` has no `imageModel` and the request doesn't override `model`, the call throws `LlmError('NO_IMAGE_MODEL')`.

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

### Minimal image-gen handler

```ts
import type { CommandHandler } from '../plugins/api.js';

const draw: CommandHandler = {
  name: 'draw',
  description: '生图',
  usage: '/draw <描述>',
  async handle(ctx) {
    const r = await ctx.llm.image({ prompt: ctx.argv.join(' ') });
    const first = r.images[0]!;
    const file = first.b64 ? `base64://${first.b64}` : first.url!;
    await ctx.reply([{ type: 'image', data: { file } }]);
  },
};
export default draw;
```

The reply must be a `Segment[]` with an `image` segment — passing a string would be sent as text. `data.file` accepts `base64://<b64>`, `http://...`, `https://...`, or `file://...`. Built-in `/image` is the reference, including the `NOT_CONFIGURED` / `NO_IMAGE_MODEL` friendly-error path.

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

The client logs one info line per successful call.
- `chat`: `{ provider, model, latencyMs, msgCount, promptTokens, completionTokens, finishReason }`
- `image`: `{ provider, model, latencyMs, n, hasB64, hasUrl }`

Failures: warn level with `code` + `httpStatus`. **Never** log `messages` content, prompts, response text, image URLs, b64 image data, or `apiKey`. HTTP error body snippets stay at debug level (≤500 bytes), in case the upstream echoes credentials.

If you write your own LLM-using handler, follow the same rule: log shape, not substance.

## Built-in commands

- **`/help`** — list registered commands (name + usage + description).
- **`/translate <text>`** — translate text to Chinese via the configured LLM.
- **`/translate`** (with image segments attached) — translate text content of those images to Chinese (requires a vision-capable model). Combined `/translate <text>` + image is also supported.
- **`/image <prompt>`** — generate an image via the configured image model and reply with it. Sends `base64://` segment when the upstream returns `b64_json`, otherwise falls back to URL. Per-user concurrency cap of 1: while one `/image` from a given QQ user is in flight, further `/image` from that same user (in any chat) replies `正在生成图片，请稍候…` until the first call resolves. Lock is in-memory and per-process; it auto-releases on success, error, or timeout via `finally`.
- **`/summary [range]`** — summarize recent group chat via the configured chat model. Group-only. `range` is one of: empty (default 1h), duration string `30m` / `2h` / `1h30m`, or a bare integer `200` interpreted as last-N messages. Output starts with a `（区间过大，仅总结最新 N 条）` notice if the request was capped at `cfg.history.maxMessagesPerSummary`. Per-group concurrency cap of 1: while one `/summary` is in flight in a group, further `/summary` calls in *that group* reply `正在总结，请稍候…` until the first resolves. Different groups are independent.

`/translate` requires `cfg.llm`; otherwise it replies `翻译功能未配置（管理员需在 bot.json5 设置 llm）`.

`/image` requires `cfg.llm` AND a provider with `imageModel`; otherwise it replies `生图功能未配置（管理员需在 bot.json5 设置 llm）` or `生图功能未配置（provider 缺 imageModel）`.

`/summary` requires `cfg.history` (otherwise replies `总结功能未配置（管理员需在 bot.json5 设置 history）`) and `cfg.llm` (otherwise replies `总结功能未配置（管理员需在 bot.json5 设置 llm）`). Buffering is gated by `cfg.allowedGroups` and excludes messages that look like commands (at-self, or first text starts with `cfg.prefix`), so the handler never sees its own callers.
