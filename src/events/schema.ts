import { z } from 'zod';

const TextSeg = z.object({
  type: z.literal('text'),
  data: z.object({ text: z.string() }),
});

const AtSeg = z.object({
  type: z.literal('at'),
  data: z.object({ qq: z.union([z.string(), z.number()]), name: z.string().optional() }),
});

const FaceSeg = z.object({
  type: z.literal('face'),
  data: z.object({ id: z.union([z.string(), z.number()]) }).passthrough(),
});

const ReplySeg = z.object({
  type: z.literal('reply'),
  data: z.object({}).passthrough(),
});

const ImageSeg = z.object({
  type: z.literal('image'),
  data: z.object({}).passthrough(),
});

const UnknownSeg = z.object({
  type: z.string(),
  data: z.unknown().optional(),
});

export const SegmentSchema = z.union([TextSeg, AtSeg, FaceSeg, ReplySeg, ImageSeg, UnknownSeg]);
export type Segment = z.infer<typeof SegmentSchema>;
export type TextSegment = z.infer<typeof TextSeg>;
export type AtSegment = z.infer<typeof AtSeg>;

const Sender = z
  .object({
    user_id: z.number(),
    nickname: z.string().optional(),
    card: z.string().optional(),
  })
  .passthrough();

const BaseMessage = z.object({
  post_type: z.literal('message'),
  time: z.number(),
  self_id: z.number(),
  message_id: z.union([z.number(), z.string()]),
  user_id: z.number(),
  message: z.array(SegmentSchema),
  raw_message: z.string().optional(),
  sender: Sender.optional(),
});

export const PrivateMessageEventSchema = BaseMessage.extend({
  message_type: z.literal('private'),
  sub_type: z.string().optional(),
});
export type PrivateMessageEvent = z.infer<typeof PrivateMessageEventSchema>;

export const GroupMessageEventSchema = BaseMessage.extend({
  message_type: z.literal('group'),
  group_id: z.number(),
  sub_type: z.string().optional(),
});
export type GroupMessageEvent = z.infer<typeof GroupMessageEventSchema>;

export const MessageEventSchema = z.union([
  PrivateMessageEventSchema,
  GroupMessageEventSchema,
]);
export type MessageEvent = z.infer<typeof MessageEventSchema>;

export const MetaEventSchema = z
  .object({
    post_type: z.literal('meta_event'),
    meta_event_type: z.string(),
    self_id: z.number(),
    time: z.number(),
  })
  .passthrough();

export const NoticeEventSchema = z
  .object({
    post_type: z.literal('notice'),
    self_id: z.number(),
    time: z.number(),
  })
  .passthrough();

export const RequestEventSchema = z
  .object({
    post_type: z.literal('request'),
    self_id: z.number(),
    time: z.number(),
  })
  .passthrough();

export const ApiResponseSchema = z
  .object({
    status: z.string(),
    retcode: z.number().optional(),
    data: z.unknown().optional(),
    echo: z.union([z.string(), z.number()]).optional(),
    message: z.string().optional(),
    wording: z.string().optional(),
  })
  .passthrough();
export type ApiResponse = z.infer<typeof ApiResponseSchema>;
