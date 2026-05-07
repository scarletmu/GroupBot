import type { CommandHandler } from '../plugins/api.js';
import { LlmError } from '../llm/api.js';

const inflight = new Set<number>();

const image: CommandHandler = {
  name: 'image',
  description: '调用配置的图像模型生图（需 LLM 配置 imageModel）',
  usage: '/image <描述>',
  scope: 'both',
  async handle(ctx) {
    const prompt = ctx.argv.join(' ').trim();
    if (!prompt) {
      await ctx.reply('用法：/image <描述>');
      return;
    }

    const userId = ctx.event.user_id;
    if (inflight.has(userId)) {
      await ctx.reply('正在生成图片，请稍候…');
      return;
    }
    inflight.add(userId);

    try {
      const r = await ctx.llm.image({ prompt });
      const first = r.images[0];
      if (!first) {
        await ctx.reply('生图失败：模型未返回图像');
        return;
      }
      const file = first.b64 ? `base64://${first.b64}` : first.url;
      if (!file) {
        await ctx.reply('生图失败：模型未返回图像');
        return;
      }
      await ctx.reply([{ type: 'image', data: { file } }]);
    } catch (err) {
      if (err instanceof LlmError) {
        if (err.code === 'NOT_CONFIGURED') {
          await ctx.reply('生图功能未配置（管理员需在 bot.json5 设置 llm）');
          return;
        }
        if (err.code === 'NO_IMAGE_MODEL') {
          await ctx.reply('生图功能未配置（provider 缺 imageModel）');
          return;
        }
      }
      throw err;
    } finally {
      inflight.delete(userId);
    }
  },
};

export default image;
