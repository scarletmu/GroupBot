import type { CommandHandler } from '../plugins/api.js';
import type { Segment } from '../events/schema.js';
import { LlmError, type ChatMessage, type ContentPart } from '../llm/api.js';

const SYSTEM_PROMPT =
  '你是翻译助手。把用户给的文本或图片中可读到的内容翻译成中文，仅输出译文，不要解释、不要附原文。';

const translate: CommandHandler = {
  name: 'translate',
  description: '翻译文本或图片到中文（多模态，需 LLM 配置）',
  usage: '/translate <文本>  或  /translate（同时附带图片）',
  scope: 'both',
  async handle(ctx) {
    const images = extractImageUrls(ctx.event.message);
    const text = ctx.argv.join(' ').trim();

    if (!text && images.length === 0) {
      await ctx.reply('用法：/translate <文本> 或 /translate（附带图片）');
      return;
    }

    ctx.log.info({ hasText: text.length > 0, imageCount: images.length }, 'translate request');

    const userMessage: ChatMessage =
      images.length === 0
        ? { role: 'user', content: text }
        : {
            role: 'user',
            content: buildMultimodalParts(text, images),
          };

    try {
      const r = await ctx.llm.chat({
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, userMessage],
      });
      await ctx.reply(r.content.trim() || '(空响应)');
    } catch (err) {
      if (err instanceof LlmError && err.code === 'NOT_CONFIGURED') {
        await ctx.reply('翻译功能未配置（管理员需在 bot.json5 设置 llm）');
        return;
      }
      throw err;
    }
  },
};

export default translate;

function extractImageUrls(segments: Segment[]): string[] {
  const urls: string[] = [];
  for (const seg of segments) {
    if (seg.type !== 'image') continue;
    const data = seg.data;
    if (!data || typeof data !== 'object') continue;
    const url = (data as Record<string, unknown>).url;
    if (typeof url === 'string' && url.length > 0) urls.push(url);
  }
  return urls;
}

function buildMultimodalParts(text: string, images: string[]): ContentPart[] {
  const parts: ContentPart[] = [];
  if (text) parts.push({ type: 'text', text });
  for (const url of images) parts.push({ type: 'image_url', image_url: { url } });
  return parts;
}
