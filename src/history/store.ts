import { appendFile, mkdir, readdir, readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Logger } from 'pino';
import type { GroupMessageEvent } from '../events/schema.js';
import { renderMessageText, senderName } from './format.js';

export interface HistoryRecord {
  ts: number;
  mid: string | number;
  gid: number;
  uid: number;
  name: string;
  text: string;
}

export interface RecentArgs {
  groupId: number;
  sinceMs?: number;
  lastN?: number;
  capMessages: number;
}

export interface HistoryReader {
  recent(args: RecentArgs): Promise<HistoryRecord[]>;
}

interface StoreOpts {
  dir: string;
  log: Logger;
}

const FILE_PREFIX = 'group-';
const FILE_SUFFIX = '.jsonl';

export class HistoryStore implements HistoryReader {
  private readonly dir: string;
  private readonly log: Logger;
  private mkdirOnce?: Promise<void>;

  constructor(opts: StoreOpts) {
    this.dir = resolve(opts.dir);
    this.log = opts.log;
  }

  async append(ev: GroupMessageEvent): Promise<void> {
    await this.ensureDir();
    const tsMs = ev.time * 1000;
    const rec: HistoryRecord = {
      ts: tsMs,
      mid: ev.message_id,
      gid: ev.group_id,
      uid: ev.user_id,
      name: senderName(ev),
      text: renderMessageText(ev.message),
    };
    const path = resolve(this.dir, fileName(ev.group_id, dayKey(new Date(tsMs))));
    await appendFile(path, JSON.stringify(rec) + '\n', 'utf8');
  }

  async recent(args: RecentArgs): Promise<HistoryRecord[]> {
    const { groupId, sinceMs, lastN, capMessages } = args;
    const today = new Date();
    const yesterday = new Date(today.getTime() - 24 * 3600 * 1000);
    const candidates = [
      resolve(this.dir, fileName(groupId, dayKey(yesterday))),
      resolve(this.dir, fileName(groupId, dayKey(today))),
    ];
    const out: HistoryRecord[] = [];
    for (const p of candidates) {
      const lines = await readJsonlSafe(p);
      for (const line of lines) {
        try {
          const r = JSON.parse(line) as HistoryRecord;
          if (r.gid !== groupId) continue;
          if (sinceMs !== undefined && r.ts < sinceMs) continue;
          out.push(r);
        } catch {
          // skip malformed line
        }
      }
    }
    out.sort((a, b) => a.ts - b.ts);
    if (lastN !== undefined && out.length > lastN) {
      return out.slice(out.length - lastN);
    }
    if (out.length > capMessages) {
      return out.slice(out.length - capMessages);
    }
    return out;
  }

  async cleanupOlderThan(days: number): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    const cutoff = dayKey(new Date(Date.now() - days * 24 * 3600 * 1000));
    let removed = 0;
    for (const name of entries) {
      if (!name.startsWith(FILE_PREFIX) || !name.endsWith(FILE_SUFFIX)) continue;
      const dk = name.slice(name.lastIndexOf('-') + 1, -FILE_SUFFIX.length);
      if (!/^\d{8}$/.test(dk)) continue;
      if (dk < cutoff) {
        try {
          await unlink(resolve(this.dir, name));
          removed += 1;
        } catch (err) {
          this.log.warn({ file: name, err: String(err) }, 'history cleanup unlink failed');
        }
      }
    }
    if (removed > 0) {
      this.log.info({ removed, days }, 'history cleanup');
    }
  }

  async close(): Promise<void> {
    // No persistent handles in this implementation; appendFile opens/closes per call.
  }

  private async ensureDir(): Promise<void> {
    if (!this.mkdirOnce) {
      this.mkdirOnce = mkdir(this.dir, { recursive: true }).then(() => undefined);
    }
    await this.mkdirOnce;
  }
}

function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function fileName(groupId: number, dk: string): string {
  return `${FILE_PREFIX}${groupId}-${dk}${FILE_SUFFIX}`;
}

async function readJsonlSafe(path: string): Promise<string[]> {
  try {
    const buf = await readFile(path, 'utf8');
    return buf.split('\n').filter((l) => l.length > 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}
