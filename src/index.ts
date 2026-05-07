import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import pino, { multistream, type StreamEntry } from 'pino';
import { ConfigLoader } from './config/loader.js';
import { parseFrame } from './events/parse.js';
import { isLikelyCommand } from './history/format.js';
import { HistoryStore } from './history/store.js';
import { createLlmClient } from './llm/client.js';
import { CommandRegistry } from './plugins/registry.js';
import { Dispatcher } from './router/dispatch.js';
import { Ob11Client } from './transport/ob11-client.js';
import { ReverseWsServer } from './transport/ws-server.js';

const CONFIG_PATH = process.env.QQBOT_CONFIG ?? 'config/bot.json5';

async function main(): Promise<void> {
  const bootLog = pino({
    level: 'info',
    transport: process.env.NODE_ENV === 'production' ? undefined : { target: 'pino-pretty' },
  });

  const loader = new ConfigLoader(CONFIG_PATH, bootLog);
  let cfg = await loader.load();

  const log = await buildLogger(cfg);

  loader.start();
  loader.on('change', (next, prev) => {
    cfg = next;
    if (next.log.level !== prev.log.level) {
      log.level = next.log.level;
      log.info({ level: next.log.level }, 'log level updated');
    }
  });

  const wss = new ReverseWsServer({
    host: cfg.listen.host,
    port: cfg.listen.port,
    token: cfg.listen.token,
    expectedSelfId: cfg.selfId,
    log: log.child({ mod: 'ws' }),
  });

  const client = new Ob11Client(wss, log.child({ mod: 'api' }));

  const registry = new CommandRegistry(cfg.commandsDir, log.child({ mod: 'plugins' }));
  await registry.loadAll();
  registry.start();

  const llm = createLlmClient(() => cfg, log.child({ mod: 'llm' }));

  const historyStore = cfg.history
    ? new HistoryStore({ dir: cfg.history.dir, log: log.child({ mod: 'history' }) })
    : undefined;
  let historyTick: NodeJS.Timeout | undefined;
  if (historyStore) {
    await historyStore.cleanupOlderThan(cfg.history!.retentionDays);
    historyTick = setInterval(() => {
      const h = cfg.history;
      if (!h) return;
      historyStore.cleanupOlderThan(h.retentionDays).catch((err) =>
        log.warn({ err: String(err) }, 'history cleanup failed'),
      );
    }, 3600_000);
    historyTick.unref();
  }

  const dispatcher = new Dispatcher(
    client,
    registry,
    log.child({ mod: 'dispatch' }),
    () => cfg,
    llm,
    historyStore,
  );

  wss.on('frame', (raw) => {
    const f = parseFrame(raw);
    switch (f.kind) {
      case 'private':
        dispatcher.handlePrivate(f.event).catch((err) =>
          log.error({ err: String(err) }, 'private dispatch failed'),
        );
        return;
      case 'group':
        if (
          historyStore &&
          cfg.allowedGroups.includes(f.event.group_id) &&
          !isLikelyCommand(f.event, cfg.selfId, cfg.prefix)
        ) {
          historyStore.append(f.event).catch((err) =>
            log.warn({ err: String(err) }, 'history append failed'),
          );
        }
        dispatcher.handleGroup(f.event).catch((err) =>
          log.error({ err: String(err) }, 'group dispatch failed'),
        );
        return;
      case 'api-response':
        client.resolveResponse(f.response);
        return;
      case 'meta':
      case 'notice':
      case 'request':
      case 'unknown':
        log.debug({ kind: f.kind }, 'non-message frame');
        return;
      case 'invalid':
        log.warn({ err: f.error }, 'invalid frame; dropped');
        return;
    }
  });

  await wss.start();

  log.info(
    {
      listen: `${cfg.listen.host}:${cfg.listen.port}`,
      selfId: cfg.selfId,
      allowedGroups: cfg.allowedGroups.length,
      allowedUsers: cfg.allowedUsers.length,
      prefix: cfg.prefix,
      commands: registry.list().map((h) => h.name),
    },
    'qqbot ready',
  );

  const shutdown = async (sig: string) => {
    log.info({ sig }, 'shutting down');
    if (historyTick) clearInterval(historyTick);
    await loader.stop();
    await registry.stop();
    await wss.stop();
    if (historyStore) await historyStore.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  process.on('uncaughtException', (err) => {
    log.error({ err: { message: err.message, stack: err.stack } }, 'uncaught exception');
  });
  process.on('unhandledRejection', (reason) => {
    log.error({ reason: String(reason) }, 'unhandled rejection');
  });
}

async function buildLogger(cfg: { log: { level: string; dir?: string | undefined } }) {
  const streams: StreamEntry[] = [];
  if (process.env.NODE_ENV === 'production') {
    streams.push({ level: cfg.log.level as pino.Level, stream: process.stdout });
  } else {
    const pretty = (await import('pino-pretty')).default({ colorize: true });
    streams.push({ level: cfg.log.level as pino.Level, stream: pretty });
  }
  if (cfg.log.dir) {
    const dir = resolve(cfg.log.dir);
    await mkdir(dir, { recursive: true });
    const dest = pino.destination({ dest: resolve(dir, 'bot.log'), sync: false, mkdir: true });
    streams.push({ level: cfg.log.level as pino.Level, stream: dest });
  }
  return pino({ level: cfg.log.level as pino.Level }, multistream(streams));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('fatal:', err);
  process.exit(1);
});
