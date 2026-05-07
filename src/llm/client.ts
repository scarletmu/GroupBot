import type { Logger } from 'pino';
import type { BotConfig, LlmProviderConfig } from '../config/schema.js';
import {
  LlmError,
  type ChatRequest,
  type ChatResponse,
  type ImageItem,
  type ImageRequest,
  type ImageResponse,
  type LlmClient,
} from './api.js';

interface OpenAiResponseChoice {
  message?: { role?: string; content?: string };
  finish_reason?: string;
}
interface OpenAiResponseUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}
interface OpenAiChatBody {
  choices?: OpenAiResponseChoice[];
  usage?: OpenAiResponseUsage;
  model?: string;
}

interface OpenAiImageDataItem {
  url?: string;
  b64_json?: string;
}
interface OpenAiImageBody {
  data?: OpenAiImageDataItem[];
  model?: string;
}

export function createLlmClient(cfg: () => BotConfig, log: Logger): LlmClient {
  return {
    async chat(req: ChatRequest): Promise<ChatResponse> {
      const { provider: providerName, p } = resolveProvider(cfg(), req.provider);
      const model = req.model ?? p.model;
      const maxTokens = req.maxTokens ?? p.maxTokens;
      const url = joinUrl(p.baseUrl, '/chat/completions');

      const body: Record<string, unknown> = {
        model,
        messages: req.messages,
        stream: false,
      };
      if (req.temperature !== undefined) body.temperature = req.temperature;
      if (req.topP !== undefined) body.top_p = req.topP;
      if (maxTokens !== undefined) body.max_tokens = maxTokens;

      const { res, latencyMs } = await postJson({
        url,
        body,
        provider: p,
        signal: req.signal,
        log,
        logCtx: { provider: providerName, model },
      });

      const parsed = await parseJsonOrThrow<OpenAiChatBody>(res, {
        log,
        provider: providerName,
        model,
        latencyMs,
      });

      const choice = parsed.choices?.[0];
      const content = choice?.message?.content;
      if (typeof content !== 'string') {
        log.warn(
          { provider: providerName, model, code: 'PARSE', latencyMs },
          'llm response missing choices[0].message.content',
        );
        throw new LlmError('PARSE', 'missing choices[0].message.content');
      }

      const out: ChatResponse = {
        content,
        model: parsed.model ?? model,
        provider: providerName,
      };
      if (choice?.finish_reason) out.finishReason = choice.finish_reason;
      if (parsed.usage) {
        const u = parsed.usage;
        const usage: ChatResponse['usage'] = {};
        if (u.prompt_tokens !== undefined) usage.promptTokens = u.prompt_tokens;
        if (u.completion_tokens !== undefined) usage.completionTokens = u.completion_tokens;
        if (u.total_tokens !== undefined) usage.totalTokens = u.total_tokens;
        if (Object.keys(usage).length > 0) out.usage = usage;
      }

      log.info(
        {
          provider: providerName,
          model: out.model,
          latencyMs,
          promptTokens: out.usage?.promptTokens,
          completionTokens: out.usage?.completionTokens,
          finishReason: out.finishReason,
          msgCount: req.messages.length,
        },
        'llm chat ok',
      );

      return out;
    },

    async image(req: ImageRequest): Promise<ImageResponse> {
      const llm = cfg().llm;
      const providerName = req.provider ?? llm?.imageDefault ?? llm?.default;
      const { provider: resolvedName, p } = resolveProvider(cfg(), providerName);
      const model = req.model ?? p.imageModel;
      if (!model) {
        throw new LlmError(
          'NO_IMAGE_MODEL',
          `provider "${resolvedName}" has no imageModel and request did not specify one`,
        );
      }
      const url = joinUrl(p.baseUrl, '/images/generations');
      const n = req.n ?? 1;

      const body: Record<string, unknown> = { model, prompt: req.prompt, n };
      if (req.size) body.size = req.size;

      const { res, latencyMs } = await postJson({
        url,
        body,
        provider: p,
        signal: req.signal,
        log,
        logCtx: { provider: resolvedName, model },
      });

      const parsed = await parseJsonOrThrow<OpenAiImageBody>(res, {
        log,
        provider: resolvedName,
        model,
        latencyMs,
      });

      const items: ImageItem[] = [];
      for (const d of parsed.data ?? []) {
        const item: ImageItem = {};
        if (typeof d.b64_json === 'string' && d.b64_json.length > 0) item.b64 = d.b64_json;
        if (typeof d.url === 'string' && d.url.length > 0) item.url = d.url;
        if (item.b64 || item.url) items.push(item);
      }
      if (items.length === 0) {
        log.warn(
          { provider: resolvedName, model, code: 'PARSE', latencyMs },
          'llm image response had no usable b64_json or url',
        );
        throw new LlmError('PARSE', 'no usable image data in response');
      }

      const out: ImageResponse = {
        images: items,
        model: parsed.model ?? model,
        provider: resolvedName,
      };

      log.info(
        {
          provider: resolvedName,
          model: out.model,
          latencyMs,
          n: items.length,
          hasB64: items.some((i) => i.b64 !== undefined),
          hasUrl: items.some((i) => i.url !== undefined),
        },
        'llm image ok',
      );

      return out;
    },
  };
}

function resolveProvider(
  cfgVal: BotConfig,
  requested: string | undefined,
): { provider: string; p: LlmProviderConfig } {
  const llm = cfgVal.llm;
  if (!llm || Object.keys(llm.providers ?? {}).length === 0) {
    throw new LlmError('NOT_CONFIGURED', 'llm config missing or providers empty');
  }
  const providerName = requested ?? llm.default;
  if (!providerName) {
    throw new LlmError('NOT_CONFIGURED', 'no provider specified and llm.default not set');
  }
  const p = llm.providers[providerName];
  if (!p) {
    throw new LlmError('PROVIDER_NOT_FOUND', `unknown provider: ${providerName}`);
  }
  return { provider: providerName, p };
}

interface PostJsonArgs {
  url: string;
  body: Record<string, unknown>;
  provider: LlmProviderConfig;
  signal?: AbortSignal;
  log: Logger;
  logCtx: { provider: string; model: string };
}

async function postJson(
  args: PostJsonArgs,
): Promise<{ res: Response; latencyMs: number }> {
  const { url, body, provider: p, signal, log, logCtx } = args;
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, p.timeout);
  const onUserAbort = () => ac.abort();
  if (signal) {
    if (signal.aborted) onUserAbort();
    else signal.addEventListener('abort', onUserAbort, { once: true });
  }

  const startedAt = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${p.apiKey}`,
        ...(p.headers ?? {}),
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onUserAbort);
    const latencyMs = Date.now() - startedAt;
    if (timedOut || isAbortError(err)) {
      log.warn({ ...logCtx, code: 'TIMEOUT', latencyMs }, 'llm request timed out');
      throw new LlmError('TIMEOUT', 'llm request timed out');
    }
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ ...logCtx, code: 'NETWORK', latencyMs }, 'llm network error');
    throw new LlmError('NETWORK', `network error: ${msg}`);
  }
  clearTimeout(timer);
  signal?.removeEventListener('abort', onUserAbort);
  const latencyMs = Date.now() - startedAt;

  if (!res.ok) {
    const snippet = await readBodySnippet(res);
    log.warn(
      { ...logCtx, code: 'HTTP', httpStatus: res.status, latencyMs },
      'llm http error',
    );
    log.debug({ provider: logCtx.provider, snippet }, 'llm http error body');
    throw new LlmError('HTTP', `http ${res.status}`, res.status);
  }

  return { res, latencyMs };
}

async function parseJsonOrThrow<T>(
  res: Response,
  ctx: { log: Logger; provider: string; model: string; latencyMs: number },
): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch (err) {
    ctx.log.warn(
      { provider: ctx.provider, model: ctx.model, code: 'PARSE', latencyMs: ctx.latencyMs },
      'llm response not json',
    );
    throw new LlmError('PARSE', `response not JSON: ${(err as Error).message}`);
  }
}

function joinUrl(base: string, path: string): string {
  const b = base.endsWith('/') ? base.slice(0, -1) : base;
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${b}${p}`;
}

async function readBodySnippet(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 500);
  } catch {
    return '';
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}
