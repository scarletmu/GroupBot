import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import JSON5 from 'json5';
import chokidar, { type FSWatcher } from 'chokidar';
import type { Logger } from 'pino';
import { BotConfigSchema, type BotConfig } from './schema.js';

const HOT_RELOAD_KEYS = [
  'allowedGroups',
  'allowedUsers',
  'prefix',
  'rateLimit',
  'log.level',
] as const;

export interface ConfigLoader extends EventEmitter {
  on(event: 'change', l: (cfg: BotConfig, prev: BotConfig) => void): this;
  on(event: 'restart-required', l: (reason: string) => void): this;
}

export class ConfigLoader extends EventEmitter {
  private current!: BotConfig;
  private watcher?: FSWatcher;

  constructor(
    private readonly path: string,
    private readonly log: Logger,
  ) {
    super();
  }

  get value(): BotConfig {
    return this.current;
  }

  async load(): Promise<BotConfig> {
    const next = await this.readAndValidate();
    this.current = next;
    return next;
  }

  start(): void {
    if (this.watcher) return;
    this.watcher = chokidar.watch(this.path, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 30 },
    });
    this.watcher.on('change', () => this.reload());
  }

  async stop(): Promise<void> {
    await this.watcher?.close();
    this.watcher = undefined;
  }

  private async reload(): Promise<void> {
    let next: BotConfig;
    try {
      next = await this.readAndValidate();
    } catch (err) {
      this.log.error({ err: errInfo(err) }, 'config reload failed; keeping previous');
      return;
    }
    const prev = this.current;
    this.current = next;

    const restartReason = listenChanged(prev, next);
    if (restartReason) {
      this.log.warn({ reason: restartReason }, 'listen.* changed; restart required');
      this.emit('restart-required', restartReason);
    }
    this.log.info({ keys: HOT_RELOAD_KEYS }, 'config reloaded');
    this.emit('change', next, prev);
  }

  private async readAndValidate(): Promise<BotConfig> {
    const raw = await readFile(resolve(this.path), 'utf8');
    const obj = JSON5.parse(raw);
    return BotConfigSchema.parse(obj);
  }
}

function listenChanged(a: BotConfig, b: BotConfig): string | null {
  if (a.listen.host !== b.listen.host) return 'listen.host';
  if (a.listen.port !== b.listen.port) return 'listen.port';
  if (a.listen.token !== b.listen.token) return 'listen.token';
  return null;
}

function errInfo(err: unknown): { message: string; name?: string; issues?: unknown } {
  if (err instanceof Error) {
    const out: { message: string; name?: string; issues?: unknown } = {
      message: err.message,
      name: err.name,
    };
    if ('issues' in err) out.issues = (err as { issues: unknown }).issues;
    return out;
  }
  return { message: String(err) };
}
