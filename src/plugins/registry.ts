import { readdir, stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import chokidar, { type FSWatcher } from 'chokidar';
import type { Logger } from 'pino';
import { isCommandHandler, type CommandHandler } from './api.js';

export class CommandRegistry {
  private readonly handlers = new Map<string, CommandHandler>();
  private readonly fileToName = new Map<string, string>();
  private watcher?: FSWatcher;

  constructor(
    private readonly dir: string,
    private readonly log: Logger,
  ) {}

  list(): CommandHandler[] {
    return [...this.handlers.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): CommandHandler | undefined {
    return this.handlers.get(name.toLowerCase());
  }

  async loadAll(): Promise<void> {
    const dir = resolve(this.dir);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (err) {
      this.log.warn({ err: String(err), dir }, 'commandsDir not found; no commands loaded');
      return;
    }
    for (const name of entries) {
      if (!isCommandFile(name)) continue;
      await this.loadFile(resolve(dir, name)).catch((err) => {
        this.log.error({ err: String(err), file: name }, 'failed to load command');
      });
    }
    this.log.info(
      { commands: this.list().map((h) => h.name) },
      'commands loaded',
    );
  }

  start(): void {
    if (this.watcher) return;
    const dir = resolve(this.dir);
    this.watcher = chokidar.watch(dir, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 30 },
    });
    const reload = (path: string) => {
      if (!isCommandFile(path)) return;
      this.loadFile(path).catch((err) => {
        this.log.error({ err: String(err), file: path }, 'reload failed');
      });
    };
    this.watcher.on('add', reload);
    this.watcher.on('change', reload);
    this.watcher.on('unlink', (path) => {
      if (!isCommandFile(path)) return;
      const name = this.fileToName.get(path);
      if (!name) return;
      this.handlers.delete(name);
      this.fileToName.delete(path);
      this.log.info({ file: path, cmd: name }, 'command unloaded');
    });
  }

  async stop(): Promise<void> {
    await this.watcher?.close();
    this.watcher = undefined;
  }

  private async loadFile(absPath: string): Promise<void> {
    const st = await stat(absPath).catch(() => null);
    if (!st || !st.isFile()) return;

    const url = pathToFileURL(absPath).href + `?v=${Date.now()}`;
    let mod: unknown;
    try {
      mod = await import(url);
    } catch (err) {
      this.log.error({ err: String(err), file: absPath }, 'import failed');
      return;
    }
    const def = (mod as { default?: unknown }).default;
    if (!isCommandHandler(def)) {
      this.log.error({ file: absPath }, 'module default export is not a CommandHandler');
      return;
    }
    const name = def.name.toLowerCase();
    const prev = this.fileToName.get(absPath);
    if (prev && prev !== name) {
      this.handlers.delete(prev);
    }
    if (!def.usage) {
      this.log.warn({ cmd: name }, 'command missing usage; consider adding one');
    }
    this.handlers.set(name, def);
    this.fileToName.set(absPath, name);
    this.log.info({ cmd: name, file: absPath }, 'command (re)loaded');
  }
}

function isCommandFile(p: string): boolean {
  const ext = extname(p);
  if (ext !== '.ts' && ext !== '.js' && ext !== '.mts' && ext !== '.mjs') return false;
  return !p.endsWith('.d.ts');
}
