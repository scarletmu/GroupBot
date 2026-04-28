import type { Logger } from 'pino';
import type { BotConfig } from '../config/schema.js';
import type {
  GroupMessageEvent,
  PrivateMessageEvent,
  Segment,
} from '../events/schema.js';
import type { LlmClient } from '../llm/api.js';
import type { CommandRegistry } from '../plugins/registry.js';
import type { Ob11Client } from '../transport/ob11-client.js';
import type { CommandContext, CommandHandler, ReplyContent } from '../plugins/api.js';
import { parseCommand } from './parse-cmd.js';
import { evaluateGroup, evaluatePrivate } from './trigger.js';

interface RateState {
  times: number[];
  warnedUntil: number;
}

export class Dispatcher {
  private readonly rate = new Map<number, RateState>();

  constructor(
    private readonly client: Ob11Client,
    private readonly registry: CommandRegistry,
    private readonly log: Logger,
    private readonly cfg: () => BotConfig,
    private readonly llm: LlmClient,
  ) {}

  async handlePrivate(ev: PrivateMessageEvent): Promise<void> {
    const cfg = this.cfg();
    const trig = evaluatePrivate(ev, cfg);
    if (!trig.triggered) {
      this.log.debug({ reason: trig.reason, mid: ev.message_id }, 'private dropped');
      return;
    }
    await this.runTriggered(ev, trig.commandText);
  }

  async handleGroup(ev: GroupMessageEvent): Promise<void> {
    const cfg = this.cfg();
    const trig = evaluateGroup(ev, cfg);
    if (!trig.triggered) {
      this.log.debug(
        { reason: trig.reason, gid: ev.group_id, mid: ev.message_id },
        'group dropped',
      );
      return;
    }
    await this.runTriggered(ev, trig.commandText);
  }

  private async runTriggered(
    ev: PrivateMessageEvent | GroupMessageEvent,
    commandText: string,
  ): Promise<void> {
    const cfg = this.cfg();
    const startNs = Date.now();
    const parsed = parseCommand(commandText);
    if (!parsed) return;

    const limited = this.checkRateLimit(ev.user_id, cfg);
    if (limited === 'warn') {
      await this.safeReply(ev, '操作过于频繁，请稍后再试').catch(() => undefined);
      this.log.info(
        { source: ev.message_type, userId: ev.user_id, cmd: parsed.cmd },
        'rate limited (warned)',
      );
      return;
    }
    if (limited === 'silent') {
      this.log.debug(
        { source: ev.message_type, userId: ev.user_id, cmd: parsed.cmd },
        'rate limited (silent)',
      );
      return;
    }

    const handler = this.registry.get(parsed.cmd);
    if (!handler) {
      await this.safeReply(ev, `未知命令，${cfg.prefix}help 查看`).catch(() => undefined);
      this.logTrigger(ev, parsed.cmd, parsed.argv.length, Date.now() - startNs, true, 'unknown');
      return;
    }
    if (!scopeAllows(handler, ev.message_type)) {
      this.log.debug({ cmd: handler.name, scope: handler.scope }, 'scope mismatch');
      return;
    }

    const ctx: CommandContext = {
      event: ev,
      argv: parsed.argv,
      reply: (content) => this.reply(ev, content),
      log: this.log.child({ cmd: handler.name }),
      cfg,
      listCommands: () => this.registry.list(),
      llm: this.llm,
    };

    try {
      await handler.handle(ctx);
      this.logTrigger(ev, handler.name, parsed.argv.length, Date.now() - startNs, true);
    } catch (err) {
      this.log.error(
        { err: errInfo(err), cmd: handler.name, mid: ev.message_id },
        'handler threw',
      );
      await this.safeReply(ev, '命令执行失败').catch(() => undefined);
      this.logTrigger(ev, handler.name, parsed.argv.length, Date.now() - startNs, false);
    }
  }

  private async reply(
    ev: PrivateMessageEvent | GroupMessageEvent,
    content: ReplyContent,
  ): Promise<void> {
    const segs = normalize(content);
    if (ev.message_type === 'private') {
      await this.client.sendPrivateMsg(ev.user_id, segs);
    } else {
      await this.client.sendGroupMsg(ev.group_id, segs);
    }
  }

  private async safeReply(
    ev: PrivateMessageEvent | GroupMessageEvent,
    content: ReplyContent,
  ): Promise<void> {
    try {
      await this.reply(ev, content);
    } catch (err) {
      this.log.warn({ err: errInfo(err) }, 'reply failed');
    }
  }

  private checkRateLimit(userId: number, cfg: BotConfig): 'ok' | 'warn' | 'silent' {
    const now = Date.now();
    const win = cfg.rateLimit.windowMs;
    const max = cfg.rateLimit.perUser;
    let s = this.rate.get(userId);
    if (!s) {
      s = { times: [], warnedUntil: 0 };
      this.rate.set(userId, s);
    }
    s.times = s.times.filter((t) => now - t < win);
    if (s.times.length < max) {
      if (s.warnedUntil && now >= s.warnedUntil) s.warnedUntil = 0;
      s.times.push(now);
      return 'ok';
    }
    if (now < s.warnedUntil) return 'silent';
    s.warnedUntil = now + win;
    return 'warn';
  }

  private logTrigger(
    ev: PrivateMessageEvent | GroupMessageEvent,
    cmd: string,
    argvLen: number,
    latencyMs: number,
    ok: boolean,
    note?: string,
  ): void {
    const base = {
      source: ev.message_type,
      userId: ev.user_id,
      cmd,
      argvLen,
      latencyMs,
      ok,
      mid: ev.message_id,
    };
    const payload = ev.message_type === 'group' ? { ...base, groupId: ev.group_id } : base;
    if (note) (payload as Record<string, unknown>).note = note;
    this.log.info(payload, 'trigger');
  }
}

function scopeAllows(h: CommandHandler, mt: 'private' | 'group'): boolean {
  const scope = h.scope ?? 'both';
  if (scope === 'both') return true;
  return scope === mt;
}

function normalize(content: ReplyContent): Segment[] {
  if (typeof content === 'string') return [{ type: 'text', data: { text: content } }];
  return content;
}

function errInfo(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) {
    const out: { message: string; stack?: string } = { message: err.message };
    if (err.stack) out.stack = err.stack;
    return out;
  }
  return { message: String(err) };
}
