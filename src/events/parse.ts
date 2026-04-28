import {
  ApiResponseSchema,
  GroupMessageEventSchema,
  MetaEventSchema,
  NoticeEventSchema,
  PrivateMessageEventSchema,
  RequestEventSchema,
  type ApiResponse,
  type GroupMessageEvent,
  type PrivateMessageEvent,
} from './schema.js';

export type ParsedFrame =
  | { kind: 'private'; event: PrivateMessageEvent }
  | { kind: 'group'; event: GroupMessageEvent }
  | { kind: 'meta'; raw: unknown }
  | { kind: 'notice'; raw: unknown }
  | { kind: 'request'; raw: unknown }
  | { kind: 'api-response'; response: ApiResponse }
  | { kind: 'unknown'; raw: unknown }
  | { kind: 'invalid'; raw: unknown; error: string };

export function parseFrame(raw: unknown): ParsedFrame {
  if (!raw || typeof raw !== 'object') {
    return { kind: 'invalid', raw, error: 'frame is not an object' };
  }

  const post = (raw as { post_type?: unknown }).post_type;
  const status = (raw as { status?: unknown }).status;
  const echo = (raw as { echo?: unknown }).echo;

  if (!post && (status !== undefined || echo !== undefined)) {
    const r = ApiResponseSchema.safeParse(raw);
    if (r.success) return { kind: 'api-response', response: r.data };
    return { kind: 'invalid', raw, error: r.error.message };
  }

  if (post === 'message') {
    const mt = (raw as { message_type?: unknown }).message_type;
    if (mt === 'private') {
      const r = PrivateMessageEventSchema.safeParse(raw);
      if (r.success) return { kind: 'private', event: r.data };
      return { kind: 'invalid', raw, error: r.error.message };
    }
    if (mt === 'group') {
      const r = GroupMessageEventSchema.safeParse(raw);
      if (r.success) return { kind: 'group', event: r.data };
      return { kind: 'invalid', raw, error: r.error.message };
    }
    return { kind: 'unknown', raw };
  }

  if (post === 'meta_event') {
    const r = MetaEventSchema.safeParse(raw);
    if (r.success) return { kind: 'meta', raw };
    return { kind: 'invalid', raw, error: r.error.message };
  }

  if (post === 'notice') {
    const r = NoticeEventSchema.safeParse(raw);
    if (r.success) return { kind: 'notice', raw };
    return { kind: 'invalid', raw, error: r.error.message };
  }

  if (post === 'request') {
    const r = RequestEventSchema.safeParse(raw);
    if (r.success) return { kind: 'request', raw };
    return { kind: 'invalid', raw, error: r.error.message };
  }

  return { kind: 'unknown', raw };
}
