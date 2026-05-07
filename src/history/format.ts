import type { GroupMessageEvent, Segment } from '../events/schema.js';
import type { HistoryRecord } from './store.js';

export function segmentToText(seg: Segment): string {
  switch (seg.type) {
    case 'text':
      return (seg.data as { text: string }).text;
    case 'at': {
      const d = seg.data as { qq: string | number; name?: string };
      return `@${d.name ?? d.qq}`;
    }
    case 'image':
      return '[图片]';
    case 'face':
      return '[表情]';
    case 'reply':
      return '[回复]';
    default:
      return `[${seg.type}]`;
  }
}

export function renderMessageText(segs: Segment[]): string {
  return segs.map(segmentToText).join('');
}

export function senderName(ev: GroupMessageEvent): string {
  return ev.sender?.card || ev.sender?.nickname || String(ev.user_id);
}

export function formatRecord(r: HistoryRecord): string {
  const t = new Date(r.ts);
  const hh = String(t.getHours()).padStart(2, '0');
  const mm = String(t.getMinutes()).padStart(2, '0');
  return `[${hh}:${mm}] ${r.name}: ${r.text}`;
}

export type RangeArg =
  | { kind: 'duration'; ms: number }
  | { kind: 'count'; n: number }
  | { kind: 'default' }
  | { kind: 'invalid' };

export function parseRangeArg(arg: string | undefined): RangeArg {
  if (!arg) return { kind: 'default' };
  if (/^\d+$/.test(arg)) {
    const n = Number(arg);
    return n > 0 ? { kind: 'count', n } : { kind: 'invalid' };
  }
  const m = arg.match(/^(?:(\d+)h)?(?:(\d+)m)?$/);
  if (!m || (!m[1] && !m[2])) return { kind: 'invalid' };
  const ms = (Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60) * 1000;
  return ms > 0 ? { kind: 'duration', ms } : { kind: 'invalid' };
}

export function isLikelyCommand(
  ev: GroupMessageEvent,
  selfId: number,
  prefix: string,
): boolean {
  const selfStr = String(selfId);
  for (const s of ev.message) {
    if (s.type === 'at' && String((s.data as { qq?: unknown }).qq) === selfStr) {
      return true;
    }
  }
  for (const s of ev.message) {
    if (s.type === 'reply' || s.type === 'at') continue;
    if (s.type === 'text') {
      const t = (s.data as { text: string }).text.trimStart();
      return t.startsWith(prefix);
    }
    return false;
  }
  return false;
}
