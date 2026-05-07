import type { CommandHandler } from '../plugins/api.js';
import { LlmError } from '../llm/api.js';
import { formatRecord, parseRangeArg } from '../history/format.js';

const inflight = new Set<number>();

const summary: CommandHandler = {
  name: 'summary',
  description: '总结最近一段时间的群聊（仅群聊）',
  usage: '/summary [1h|30m|200]   留空默认 1h',
  scope: 'group',
  async handle(ctx) {
    if (ctx.event.message_type !== 'group') {
      await ctx.reply('总结功能仅在群聊中可用');
      return;
    }
    if (!ctx.history || !ctx.cfg.history) {
      await ctx.reply('总结功能未配置（管理员需在 bot.json5 设置 history）');
      return;
    }
    const range = parseRangeArg(ctx.argv[0]);
    if (range.kind === 'invalid') {
      await ctx.reply('用法：/summary [1h|30m|200]');
      return;
    }

    const groupId = ctx.event.group_id;
    if (inflight.has(groupId)) {
      await ctx.reply('正在总结，请稍候…');
      return;
    }
    inflight.add(groupId);
    try {
      const cap = ctx.cfg.history.maxMessagesPerSummary;
      const args =
        range.kind === 'count'
          ? { groupId, lastN: Math.min(range.n, cap), capMessages: cap }
          : {
              groupId,
              sinceMs:
                Date.now() - (range.kind === 'duration' ? range.ms : 3600_000),
              capMessages: cap,
            };
      const records = await ctx.history.recent(args);
      if (records.length === 0) {
        await ctx.reply('该时间段没有可总结的消息');
        return;
      }
      const truncated =
        (range.kind === 'count' && range.n > cap) ||
        (range.kind !== 'count' && records.length === cap);
      const transcript = records.map(formatRecord).join('\n');
      const r = await ctx.llm.chat({
        messages: [
          {
            role: 'system',
            content:
              '你是群聊总结助手。请用中文简明列出过去时段的主要话题、关键讨论点与结论。每个话题 1-2 句，最多 8 个话题。仅输出总结正文，不要前言。',
          },
          {
            role: 'user',
            content: `请总结下面这段群聊（共 ${records.length} 条）：\n\n${transcript}`,
          },
        ],
      });
      const prefix = truncated ? `（区间过大，仅总结最新 ${records.length} 条）\n` : '';
      await ctx.reply(prefix + r.content);
    } catch (err) {
      if (err instanceof LlmError && err.code === 'NOT_CONFIGURED') {
        await ctx.reply('总结功能未配置（管理员需在 bot.json5 设置 llm）');
        return;
      }
      throw err;
    } finally {
      inflight.delete(groupId);
    }
  },
};

export default summary;
