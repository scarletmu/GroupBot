import { z } from 'zod';

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
});

export type BotConfig = z.infer<typeof BotConfigSchema>;
