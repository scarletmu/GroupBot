import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { ApiResponse, Segment } from '../events/schema.js';
import type { ReverseWsServer } from './ws-server.js';

const API_TIMEOUT_MS = 10_000;

interface Pending {
  resolve(r: ApiResponse): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

export class Ob11Client {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly ws: ReverseWsServer,
    private readonly log: Logger,
  ) {}

  resolveResponse(resp: ApiResponse): void {
    if (resp.echo === undefined || resp.echo === null) return;
    const key = String(resp.echo);
    const p = this.pending.get(key);
    if (!p) return;
    this.pending.delete(key);
    clearTimeout(p.timer);
    p.resolve(resp);
  }

  async sendPrivateMsg(userId: number, message: Segment[]): Promise<ApiResponse> {
    return this.call('send_private_msg', { user_id: userId, message });
  }

  async sendGroupMsg(groupId: number, message: Segment[]): Promise<ApiResponse> {
    return this.call('send_group_msg', { group_id: groupId, message });
  }

  private call(action: string, params: Record<string, unknown>): Promise<ApiResponse> {
    if (!this.ws.isConnected()) {
      return Promise.reject(new Error('reverse-ws client not connected'));
    }
    const echo = randomUUID();
    const payload = { action, params, echo };
    const sent = this.ws.send(payload);
    if (!sent) return Promise.reject(new Error('failed to send: socket not open'));

    return new Promise<ApiResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`api ${action} timed out after ${API_TIMEOUT_MS}ms`));
      }, API_TIMEOUT_MS);
      this.pending.set(echo, { resolve, reject, timer });
    }).then((resp) => {
      if (resp.status !== 'ok' && resp.retcode !== 0) {
        this.log.warn(
          { action, retcode: resp.retcode, msg: resp.message ?? resp.wording },
          'api returned non-ok',
        );
      }
      return resp;
    });
  }
}
