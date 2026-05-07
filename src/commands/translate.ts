import type { CommandHandler } from '../plugins/api.js';
import type { Segment } from '../events/schema.js';
import { LlmError, type ChatMessage, type ContentPart } from '../llm/api.js';

const SYSTEM_PROMPT =
  '你是翻译助手。把用户给的文本或图片中可读到的内容翻译成中文，仅输出译文，不要解释、不要附原文。';
const IMAGE_FETCH_TIMEOUT_MS = 15_000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const translate: CommandHandler = {
  name: 'translate',
  description: '翻译文本或图片到中文（多模态，需 LLM 配置）',
  usage: '/translate <文本>  或  /translate（同时附带图片）',
  scope: 'both',
  async handle(ctx) {
    let images = extractImageUrls(ctx.event.message);
    let text = ctx.argv.join(' ').trim();
    const quotedId = extractReplyMessageId(ctx.event.message);
    let acknowledged = false;
    const acknowledge = () => {
      if (acknowledged) return;
      acknowledged = true;
      void ctx.reply('已收到，正在翻译，请稍候…').catch((err: unknown) => {
        ctx.log.warn({ err: errInfo(err) }, 'translate ack reply failed');
      });
    };

    if (!text && images.length === 0) {
      if (quotedId !== null) {
        acknowledge();
        const quoted = await ctx.onebot.getMessage(quotedId);
        if (quoted) {
          text = extractText(quoted.message).trim();
          images = extractImageUrls(quoted.message);
        }
      }
    }

    if (!text && images.length === 0) {
      await ctx.reply('用法：/translate <文本> 或 /translate（附带图片/引用消息）');
      return;
    }

    acknowledge();
    if (images.length > 0) {
      try {
        images = await Promise.all(images.map(fetchImageAsDataUrl));
      } catch (err) {
        ctx.log.warn({ err: errInfo(err), imageCount: images.length }, 'translate image fetch failed');
        await ctx.reply('图片读取失败，请稍后再试');
        return;
      }
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
        maxTokens: 1024,
      });
      const output = r.content.trim() || '(空响应)';
      await ctx.reply(
        quotedId === null
          ? output
          : [
              { type: 'reply', data: { id: quotedId } },
              { type: 'text', data: { text: output } },
            ],
      );
    } catch (err) {
      if (err instanceof LlmError && err.code === 'NOT_CONFIGURED') {
        await ctx.reply('翻译功能未配置（管理员需在 bot.json5 设置 llm）');
        return;
      }
      if (err instanceof LlmError && err.code === 'TIMEOUT') {
        await ctx.reply('翻译请求超时，请稍后再试');
        return;
      }
      throw err;
    }
  },
};

export default translate;

function extractReplyMessageId(segments: Segment[]): number | string | null {
  for (const seg of segments) {
    if (seg.type !== 'reply') continue;
    const data = seg.data;
    if (!data || typeof data !== 'object') return null;
    const record = data as Record<string, unknown>;
    const id = record.id ?? record.message_id;
    if (typeof id === 'number' || (typeof id === 'string' && id.length > 0)) return id;
    return null;
  }
  return null;
}

function extractText(segments: Segment[]): string {
  const chunks: string[] = [];
  for (const seg of segments) {
    if (seg.type !== 'text') continue;
    const data = seg.data;
    if (!data || typeof data !== 'object') continue;
    const text = (data as Record<string, unknown>).text;
    if (typeof text === 'string') chunks.push(text);
  }
  return chunks.join('').trim();
}

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

async function fetchImageAsDataUrl(url: string): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), IMAGE_FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { signal: ac.signal });
  } catch (err) {
    throw new Error(`image fetch failed: ${errMsg(err)}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`image fetch returned http ${res.status}`);

  const contentType = res.headers.get('content-type')?.split(';', 1)[0]?.trim() || 'image/jpeg';
  if (!contentType.startsWith('image/')) {
    throw new Error('image fetch returned non-image content');
  }

  const contentLength = res.headers.get('content-length');
  if (contentLength && Number(contentLength) > MAX_IMAGE_BYTES) {
    throw new Error('image too large');
  }

  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error('image too large');
  return `data:${contentType};base64,${bytes.toString('base64')}`;
}

function errInfo(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) {
    const out: { message: string; stack?: string } = { message: err.message };
    if (err.stack) out.stack = err.stack;
    return out;
  }
  return { message: String(err) };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
