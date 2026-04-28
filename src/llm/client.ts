import type { Logger } from 'pino';
import type { BotConfig } from '../config/schema.js';
import {
  LlmError,
  type ChatRequest,
  type ChatResponse,
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
interface OpenAiResponseBody {
  choices?: OpenAiResponseChoice[];
  usage?: OpenAiResponseUsage;
  model?: string;
}

export function createLlmClient(cfg: () => BotConfig, log: Logger): LlmClient {
  return {
    async chat(req: ChatRequest): Promise<ChatResponse> {
      const llm = cfg().llm;
      if (!llm || Object.keys(llm.providers ?? {}).length === 0) {
        throw new LlmError('NOT_CONFIGURED', 'llm config missing or providers empty');
      }
      const providerName = req.provider ?? llm.default;
      if (!providerName) {
        throw new LlmError(
          'NOT_CONFIGURED',
          'no provider specified and llm.default not set',
        );
      }
      const p = llm.providers[providerName];
      if (!p) {
        throw new LlmError('PROVIDER_NOT_FOUND', `unknown provider: ${providerName}`);
      }

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

      const ac = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        ac.abort();
      }, p.timeout);
      const onUserAbort = () => ac.abort();
      if (req.signal) {
        if (req.signal.aborted) onUserAbort();
        else req.signal.addEventListener('abort', onUserAbort, { once: true });
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
        req.signal?.removeEventListener('abort', onUserAbort);
        const latencyMs = Date.now() - startedAt;
        if (timedOut || isAbortError(err)) {
          log.warn({ provider: providerName, model, code: 'TIMEOUT', latencyMs }, 'llm request timed out');
          throw new LlmError('TIMEOUT', 'llm request timed out');
        }
        const msg = err instanceof Error ? err.message : String(err);
        log.warn({ provider: providerName, model, code: 'NETWORK', latencyMs }, 'llm network error');
        throw new LlmError('NETWORK', `network error: ${msg}`);
      }
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onUserAbort);

      const latencyMs = Date.now() - startedAt;

      if (!res.ok) {
        const snippet = await readBodySnippet(res);
        log.warn(
          { provider: providerName, model, code: 'HTTP', httpStatus: res.status, latencyMs },
          'llm http error',
        );
        log.debug({ provider: providerName, snippet }, 'llm http error body');
        throw new LlmError('HTTP', `http ${res.status}`, res.status);
      }

      let parsed: OpenAiResponseBody;
      try {
        parsed = (await res.json()) as OpenAiResponseBody;
      } catch (err) {
        log.warn({ provider: providerName, model, code: 'PARSE', latencyMs }, 'llm response not json');
        throw new LlmError('PARSE', `response not JSON: ${(err as Error).message}`);
      }

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
  };
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
