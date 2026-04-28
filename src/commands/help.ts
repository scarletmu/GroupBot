import type { CommandHandler } from '../plugins/api.js';

const help: CommandHandler = {
  name: 'help',
  description: '列出全部已注册命令',
  usage: '/help',
  scope: 'both',
  async handle(ctx) {
    const list = ctx.listCommands();
    if (list.length === 0) {
      await ctx.reply('暂无命令');
      return;
    }
    const prefix = ctx.cfg.prefix;
    const lines = list.map((h) => {
      const usage = h.usage ?? `${prefix}${h.name}`;
      return `${usage} — ${h.description}`;
    });
    await ctx.reply(lines.join('\n'));
  },
};

export default help;
