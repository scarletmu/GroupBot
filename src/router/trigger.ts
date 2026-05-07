import type { BotConfig } from '../config/schema.js';
import type {
  GroupMessageEvent,
  PrivateMessageEvent,
  Segment,
} from '../events/schema.js';

export type TriggerResult =
  | { triggered: false; reason: string }
  | { triggered: true; commandText: string; segmentsAfterAt: Segment[] };

export function evaluatePrivate(
  ev: PrivateMessageEvent,
  cfg: BotConfig,
): TriggerResult {
  if (cfg.allowedUsers.length > 0 && !cfg.allowedUsers.includes(ev.user_id)) {
    return { triggered: false, reason: 'user not in allowedUsers' };
  }
  const firstText = firstTextSegment(ev.message);
  if (!firstText) return { triggered: false, reason: 'no leading text segment' };
  const text = firstText.data.text.trimStart();
  const commandText = stripCommandPrefix(text, cfg.prefix);
  if (commandText === null) {
    return { triggered: false, reason: 'no prefix' };
  }
  return { triggered: true, commandText, segmentsAfterAt: ev.message };
}

export function evaluateGroup(
  ev: GroupMessageEvent,
  cfg: BotConfig,
): TriggerResult {
  if (!cfg.allowedGroups.includes(ev.group_id)) {
    return { triggered: false, reason: 'group not whitelisted' };
  }
  const selfIdStr = String(cfg.selfId);
  const atSelf = ev.message.some(
    (s) => s.type === 'at' && String((s.data as { qq?: unknown }).qq) === selfIdStr,
  );
  if (!atSelf) return { triggered: false, reason: 'no at-self' };

  const stripped = stripLeadingAtAndReply(ev.message, selfIdStr);
  const firstText = firstTextSegment(stripped);
  if (!firstText) return { triggered: false, reason: 'no leading text after at' };
  const text = firstText.data.text.trimStart();
  const commandText = stripCommandPrefix(text, cfg.prefix);
  if (commandText === null) return { triggered: false, reason: 'no prefix' };

  return {
    triggered: true,
    commandText,
    segmentsAfterAt: stripped,
  };
}

function stripCommandPrefix(text: string, prefix: string): string | null {
  if (text.startsWith(prefix)) return text.slice(prefix.length);
  if (prefix === '/' && text.startsWith('／')) return text.slice('／'.length);
  return null;
}

function firstTextSegment(
  segs: Segment[],
): { type: 'text'; data: { text: string } } | null {
  for (const s of segs) {
    if (s.type === 'reply' || s.type === 'at') continue;
    if (s.type === 'text') return s as { type: 'text'; data: { text: string } };
    return null;
  }
  return null;
}

function stripLeadingAtAndReply(segs: Segment[], selfIdStr: string): Segment[] {
  const out: Segment[] = [];
  let droppedAt = false;
  for (const s of segs) {
    if (!droppedAt && s.type === 'reply') continue;
    if (!droppedAt && s.type === 'at' && String((s.data as { qq?: unknown }).qq) === selfIdStr) {
      droppedAt = true;
      continue;
    }
    if (!droppedAt && s.type === 'text') {
      const t = (s.data as { text: string }).text;
      if (t.trim() === '') continue;
    }
    out.push(s);
  }
  if (out.length > 0 && out[0]!.type === 'text') {
    const head = out[0] as { type: 'text'; data: { text: string } };
    out[0] = { type: 'text', data: { text: head.data.text.replace(/^\s+/, '') } };
  }
  return out;
}
