import { EventEmitter } from 'node:events';
import { createServer, type Server as HttpServer, type IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Logger } from 'pino';

export interface ReverseWsServerOptions {
  host: string;
  port: number;
  token: string;
  log: Logger;
  expectedSelfId: number;
}

export interface ReverseWsServer {
  on(event: 'frame', l: (raw: unknown) => void): this;
  on(event: 'connect', l: (info: { uin: string | undefined; ua: string | undefined }) => void): this;
  on(event: 'disconnect', l: (info: { code: number; reason: string }) => void): this;
}

const HEARTBEAT_MS = 30_000;

export class ReverseWsServer extends EventEmitter {
  private http?: HttpServer;
  private wss?: WebSocketServer;
  private socket: WebSocket | null = null;
  private heartbeat?: NodeJS.Timeout;

  constructor(private readonly opts: ReverseWsServerOptions) {
    super();
  }

  async start(): Promise<void> {
    const { host, port, token, log } = this.opts;

    this.http = createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });

    this.wss = new WebSocketServer({ noServer: true });

    this.http.on('upgrade', (req, socket, head) => {
      const auth = headerOf(req, 'authorization');
      const provided = parseBearer(auth) ?? (req.url ? new URL(req.url, 'http://x').searchParams.get('access_token') : null);
      if (provided !== token) {
        const peer = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
        log.warn({ peer }, 'ws upgrade rejected: bad token');
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) => {
        this.wss!.emit('connection', ws, req);
      });
    });

    this.wss.on('connection', (ws, req) => this.onConnection(ws, req));

    await new Promise<void>((resolve, reject) => {
      this.http!.once('error', reject);
      this.http!.listen(port, host, () => {
        this.http!.off('error', reject);
        resolve();
      });
    });

    log.info({ host, port }, 'reverse-ws listening');
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.socket?.close();
    this.socket = null;
    await new Promise<void>((resolve) => this.wss?.close(() => resolve()));
    await new Promise<void>((resolve) => this.http?.close(() => resolve()));
  }

  send(payload: object): boolean {
    const ws = this.socket;
    if (!ws || ws.readyState !== ws.OPEN) return false;
    ws.send(JSON.stringify(payload));
    return true;
  }

  isConnected(): boolean {
    return !!this.socket && this.socket.readyState === this.socket.OPEN;
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const { log, expectedSelfId } = this.opts;
    const uin = headerOf(req, 'x-self-id');
    const ua = headerOf(req, 'user-agent');

    if (this.socket) {
      log.warn('replacing existing reverse-ws client');
      this.socket.close(1000, 'replaced');
    }
    this.socket = ws;
    if (uin && Number(uin) !== expectedSelfId) {
      log.warn({ uin, expected: expectedSelfId }, 'connecting uin mismatch with config.selfId');
    }
    log.info({ uin, ua }, 'client connected');
    this.emit('connect', { uin, ua });

    let alive = true;
    ws.on('pong', () => {
      alive = true;
    });
    this.heartbeat = setInterval(() => {
      if (!alive) {
        log.warn('ws heartbeat timeout, terminating');
        ws.terminate();
        return;
      }
      alive = false;
      try {
        ws.ping();
      } catch {
        /* ignore */
      }
    }, HEARTBEAT_MS);

    ws.on('message', (data) => {
      let raw: unknown;
      try {
        raw = JSON.parse(data.toString('utf8'));
      } catch (err) {
        log.warn({ err: String(err) }, 'invalid json frame; dropped');
        return;
      }
      this.emit('frame', raw);
    });

    ws.on('close', (code, reasonBuf) => {
      const reason = reasonBuf.toString('utf8');
      if (this.socket === ws) this.socket = null;
      if (this.heartbeat) {
        clearInterval(this.heartbeat);
        this.heartbeat = undefined;
      }
      log.info({ code, reason }, 'client disconnected');
      this.emit('disconnect', { code, reason });
    });

    ws.on('error', (err) => {
      log.warn({ err: String(err) }, 'ws error');
    });
  }
}

function headerOf(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  if (Array.isArray(v)) return v[0];
  return v;
}

function parseBearer(h: string | undefined): string | null {
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1]! : null;
}
