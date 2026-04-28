import type { Logger } from 'pino';
import type { BotConfig } from '../config/schema.js';
import type {
  GroupMessageEvent,
  PrivateMessageEvent,
  Segment,
} from '../events/schema.js';
import type { LlmClient } from '../llm/api.js';

export type CommandEvent = PrivateMessageEvent | GroupMessageEvent;

export type ReplyContent = string | Segment[];

export interface CommandContext {
  event: CommandEvent;
  argv: string[];
  reply(content: ReplyContent): Promise<void>;
  log: Logger;
  cfg: BotConfig;
  /**
   * Snapshot of currently registered command handlers, sorted by name.
   * Provided so the built-in `/help` can render the live list without
   * reaching into the registry directly. Treat as read-only.
   */
  listCommands(): readonly CommandHandler[];
  /**
   * Shared OpenAI-compatible LLM client. Always present; throws
   * `LlmError('NOT_CONFIGURED')` from `chat()` if `cfg.llm` is missing.
   * Bot stays strictly command-driven — handlers decide when (and whether)
   * to call out to an LLM. Never expose direct user→LLM dialogue.
   */
  llm: LlmClient;
}

export type CommandScope = 'private' | 'group' | 'both';

export interface CommandHandler {
  name: string;
  description: string;
  usage?: string;
  scope?: CommandScope;
  handle(ctx: CommandContext): Promise<void>;
}

export function isCommandHandler(x: unknown): x is CommandHandler {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.name === 'string' &&
    o.name.length > 0 &&
    typeof o.description === 'string' &&
    typeof o.handle === 'function'
  );
}
