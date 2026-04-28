import { z } from 'zod';

const LlmProviderSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  model: z.string().min(1),
  timeout: z.number().int().min(1000).default(30000),
  maxTokens: z.number().int().min(1).optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

const LlmConfigSchema = z
  .object({
    default: z.string().min(1).optional(),
    providers: z.record(z.string().min(1), LlmProviderSchema).default({}),
  })
  .refine(
    (v) => !v.default || Object.prototype.hasOwnProperty.call(v.providers, v.default),
    { message: 'llm.default must reference an entry in llm.providers' },
  );

export const BotConfigSchema = z.object({
  listen: z.object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    token: z.string().min(1),
  }),
  selfId: z.number().int().positive(),
  allowedGroups: z.array(z.number().int().positive()).default([]),
  allowedUsers: z.array(z.number().int().positive()).default([]),
  prefix: z.string().min(1).default('/'),
  rateLimit: z
    .object({
      perUser: z.number().int().min(1).default(5),
      windowMs: z.number().int().min(100).default(10000),
    })
    .default({ perUser: 5, windowMs: 10000 }),
  commandsDir: z.string().min(1).default('src/commands'),
  log: z
    .object({
      level: z
        .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
        .default('info'),
      dir: z.string().optional(),
    })
    .default({ level: 'info' }),
  llm: LlmConfigSchema.optional(),
});

export type BotConfig = z.infer<typeof BotConfigSchema>;
export type LlmProviderConfig = z.infer<typeof LlmProviderSchema>;
