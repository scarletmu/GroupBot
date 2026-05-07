#!/usr/bin/env node
// AC smoke harness. Boots the bot on an ephemeral port, simulates a NapCat
// reverse-WS client, exercises the §4.4 acceptance scenarios, prints a
// pass/fail summary, and tears the bot down. Run from repo root: `pnpm smoke`.

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';

const TOKEN = 'smoke-' + Math.random().toString(36).slice(2, 10);
const PORT = 17000 + Math.floor(Math.random() * 1000);
const SELF_ID = 10001;
const ALLOWED_GROUP = 12345;

let tmpDir;
let configPath;
let pingFile;
let boomFile;
let proc;
let ws;
const results = [];

const record = (label, pass, note) => {
  results.push({ label, pass, note });
  const tag = pass ? '✅' : '❌';
  console.log(`${tag} ${label}${note ? ` — ${note}` : ''}`);
};

async function main() {
  tmpDir = await mkdtemp(join(tmpdir(), 'qqbot-smoke-'));
  configPath = join(tmpDir, 'bot.json5');
  await writeFile(
    configPath,
    JSON.stringify({
      listen: { host: '127.0.0.1', port: PORT, token: TOKEN },
      selfId: SELF_ID,
      allowedGroups: [],
      allowedUsers: [],
      prefix: '/',
      rateLimit: { perUser: 5, windowMs: 10000 },
      commandsDir: 'src/commands',
      log: { level: 'info' },
    }),
  );

  proc = spawn(
    process.execPath,
    ['--import', 'tsx', 'src/index.ts'],
    { env: { ...process.env, QQBOT_CONFIG: configPath, NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  let booted = false;
  proc.stdout.on('data', (d) => {
    if (!booted && d.includes('qqbot ready')) booted = true;
  });
  proc.stderr.on('data', (d) => process.stderr.write(`[bot:err] ${d}`));

  const deadline = Date.now() + 8000;
  while (!booted && Date.now() < deadline) await sleep(100);
  if (!booted) throw new Error('bot did not reach ready in 8s');

  await acBadToken();
  await connect();

  await acPrivateHelp();
  await acPrivateChat();
  await acPrivateUnknown();
  await acGroupCmdNoAt();
  await acGroupNonWhitelisted();

  await editConfig((c) => ({ ...c, allowedGroups: [ALLOWED_GROUP] }));
  await waitForLogContains('config reloaded');
  record('AC-10 group-whitelist hot-reload', true);

  await acGroupAtPlusCmd();
  await acGroupAtNoCmd();
  await acGroupQuotedTranslateNoLlm();
  await acFullwidthSlashPrefix();

  await acHotAddCommand();

  await editConfig((c) => ({ ...c, prefix: '!' }));
  await waitForLogContains('config reloaded');
  await acPrefixSwap();

  await editConfig((c) => ({ ...c, prefix: '/' }));
  await waitForLogContains('config reloaded');

  await acHandlerThrow();
  await acRateLimit();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) process.exitCode = 1;
}

let recvBuf = [];
let nextMid = 1;
async function connect() {
  ws = new WebSocket(`ws://127.0.0.1:${PORT}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, 'X-Self-ID': String(SELF_ID) },
  });
  ws.on('message', (raw) => {
    const obj = JSON.parse(raw.toString());
    recvBuf.push(obj);
    const data = obj.action === 'get_msg'
      ? {
          message_id: obj.params.message_id,
          message: [{ type: 'text', data: { text: 'Hello from quoted message' } }],
          raw_message: 'Hello from quoted message',
        }
      : { message_id: 999 };
    ws.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: obj.echo }));
  });
  await new Promise((res, rej) => {
    ws.once('open', res);
    ws.once('error', rej);
  });
}

function frame(extra) {
  return {
    post_type: 'message',
    time: Math.floor(Date.now() / 1000),
    self_id: SELF_ID,
    message_id: nextMid++,
    user_id: 555,
    sender: { user_id: 555, nickname: 'tester' },
    raw_message: '',
    ...extra,
  };
}

async function send(ev, settleMs = 250) {
  const before = recvBuf.length;
  ws.send(JSON.stringify(ev));
  await sleep(settleMs);
  return recvBuf.slice(before);
}

async function acBadToken() {
  const bad = new WebSocket(`ws://127.0.0.1:${PORT}`, {
    headers: { Authorization: 'Bearer wrong-token', 'X-Self-ID': String(SELF_ID) },
  });
  const code = await new Promise((res) => {
    bad.on('unexpected-response', (_q, r) => res(r.statusCode));
    bad.on('error', () => res(0));
    bad.on('open', () => {
      bad.close();
      res(-1);
    });
  });
  record('AC-14 bad token rejected', code === 401, `HTTP ${code}`);
}

async function acPrivateHelp() {
  const replies = await send(frame({
    message_type: 'private', sub_type: 'friend',
    message: [{ type: 'text', data: { text: '/help' } }],
  }));
  record('AC-2 private /help', replies.length === 1 && replies[0].action === 'send_private_msg');
}

async function acPrivateChat() {
  const replies = await send(frame({
    message_type: 'private', sub_type: 'friend',
    message: [{ type: 'text', data: { text: '你好' } }],
  }));
  record('AC-3 private chitchat silent', replies.length === 0);
}

async function acPrivateUnknown() {
  const replies = await send(frame({
    message_type: 'private', sub_type: 'friend',
    message: [{ type: 'text', data: { text: '/no-such-cmd' } }],
  }));
  const ok =
    replies.length === 1 &&
    typeof replies[0].params.message[0].data.text === 'string' &&
    replies[0].params.message[0].data.text.includes('未知命令');
  record('AC-4 unknown command reply', ok);
}

async function acGroupCmdNoAt() {
  const replies = await send(frame({
    message_type: 'group', group_id: ALLOWED_GROUP,
    message: [{ type: 'text', data: { text: '/help' } }],
  }));
  record('AC-7 group cmd no at silent', replies.length === 0);
}

async function acGroupNonWhitelisted() {
  const replies = await send(frame({
    message_type: 'group', group_id: 99999,
    message: [{ type: 'at', data: { qq: String(SELF_ID) } }, { type: 'text', data: { text: ' /help' } }],
  }));
  record('AC-8 non-whitelisted group silent', replies.length === 0);
}

async function acGroupAtPlusCmd() {
  const replies = await send(frame({
    message_type: 'group', group_id: ALLOWED_GROUP,
    message: [{ type: 'at', data: { qq: String(SELF_ID) } }, { type: 'text', data: { text: ' /help' } }],
  }));
  record('AC-5 group @bot /help', replies.length === 1 && replies[0].action === 'send_group_msg');
}

async function acGroupAtNoCmd() {
  const replies = await send(frame({
    message_type: 'group', group_id: ALLOWED_GROUP,
    message: [{ type: 'at', data: { qq: String(SELF_ID) } }, { type: 'text', data: { text: ' 在吗' } }],
  }));
  record('AC-6 group at-only silent', replies.length === 0);
}

async function acGroupQuotedTranslateNoLlm() {
  const replies = await send(frame({
    message_type: 'group', group_id: ALLOWED_GROUP,
    message: [
      { type: 'reply', data: { id: 4242 } },
      { type: 'at', data: { qq: String(SELF_ID) } },
      { type: 'text', data: { text: ' /translate' } },
    ],
  }), 500);
  const ok =
    replies.length === 3 &&
    replies[0].action === 'send_group_msg' &&
    replies[0].params.message[0].data.text.includes('已收到') &&
    replies[1].action === 'get_msg' &&
    replies[1].params.message_id === 4242 &&
    replies[2].action === 'send_group_msg' &&
    replies[2].params.message[0].data.text.includes('翻译功能未配置');
  record('translate quoted message fetches source', ok);
}

async function acFullwidthSlashPrefix() {
  const privateReplies = await send(frame({
    user_id: 556,
    message_type: 'private', sub_type: 'friend',
    message: [{ type: 'text', data: { text: '／help' } }],
  }));
  const groupReplies = await send(frame({
    user_id: 557,
    message_type: 'group', group_id: ALLOWED_GROUP,
    message: [{ type: 'at', data: { qq: String(SELF_ID) } }, { type: 'text', data: { text: ' ／help' } }],
  }));
  record(
    'fullwidth slash prefix',
    privateReplies.length === 1 &&
      privateReplies[0].action === 'send_private_msg' &&
      groupReplies.length === 1 &&
      groupReplies[0].action === 'send_group_msg',
  );
}

async function acHotAddCommand() {
  pingFile = 'src/commands/_smoke_ping.ts';
  await writeFile(pingFile,
`import type { CommandHandler } from '../plugins/api.js';
const ping: CommandHandler = {
  name: 'smokeping',
  description: 'smoke test ping',
  usage: '/smokeping',
  async handle(ctx) { await ctx.reply('pong'); },
};
export default ping;
`);
  await waitForLogContains('command (re)loaded');
  await sleep(150);
  const replies = await send(frame({
    message_type: 'private', sub_type: 'friend',
    message: [{ type: 'text', data: { text: '/smokeping' } }],
  }));
  const ok =
    replies.length === 1 &&
    replies[0].params.message[0].data.text === 'pong';
  record('AC-11 hot-load new command', ok);
}

async function acPrefixSwap() {
  const bang = await send(frame({
    message_type: 'private', sub_type: 'friend',
    message: [{ type: 'text', data: { text: '!help' } }],
  }));
  const slash = await send(frame({
    message_type: 'private', sub_type: 'friend',
    message: [{ type: 'text', data: { text: '/help' } }],
  }));
  record('AC-9 prefix hot-swap', bang.length === 1 && slash.length === 0);
}

async function acHandlerThrow() {
  boomFile = 'src/commands/_smoke_boom.ts';
  await writeFile(boomFile,
`import type { CommandHandler } from '../plugins/api.js';
const boom: CommandHandler = {
  name: 'smokeboom',
  description: 'smoke test throw',
  usage: '/smokeboom',
  async handle() { throw new Error('intentional'); },
};
export default boom;
`);
  await waitForLogContains('command (re)loaded');
  await sleep(150);
  const replies = await send(frame({
    user_id: 888,
    message_type: 'private', sub_type: 'friend',
    message: [{ type: 'text', data: { text: '/smokeboom' } }],
  }));
  const ok =
    replies.length === 1 &&
    replies[0].params.message[0].data.text === '命令执行失败' &&
    proc.exitCode === null;
  record('AC-13 handler throw isolated', ok);
}

async function acRateLimit() {
  const u = 7777;
  const seq = [];
  for (let i = 0; i < 7; i++) {
    const replies = await send(
      frame({
        user_id: u,
        message_type: 'private', sub_type: 'friend',
        message: [{ type: 'text', data: { text: '/help' } }],
      }),
      120,
    );
    seq.push(replies.length === 1 ? replies[0].params.message[0].data.text : null);
  }
  const firstFive = seq.slice(0, 5).every((t) => t && !t.includes('过于频繁'));
  const sixthWarns = !!seq[5] && seq[5].includes('过于频繁');
  const seventhSilent = seq[6] === null;
  record('AC-12 rate limit', firstFive && sixthWarns && seventhSilent,
    `replies=[${seq.map((s) => (s === null ? 'silent' : 'msg')).join(',')}]`);
}

async function editConfig(mut) {
  const text = await import('node:fs/promises').then((m) => m.readFile(configPath, 'utf8'));
  const cur = JSON.parse(text);
  const next = mut(cur);
  await writeFile(configPath, JSON.stringify(next, null, 2));
}

async function waitForLogContains(needle, timeoutMs = 3000) {
  const start = Date.now();
  return await new Promise((resolve, reject) => {
    let done = false;
    const onData = (d) => {
      if (d.includes(needle) && !done) {
        done = true;
        proc.stdout.off('data', onData);
        resolve();
      }
    };
    proc.stdout.on('data', onData);
    setTimeout(() => {
      if (!done) {
        proc.stdout.off('data', onData);
        reject(new Error(`timeout waiting for log "${needle}" after ${Date.now() - start}ms`));
      }
    }, timeoutMs);
  });
}

async function cleanup() {
  try { ws?.close(); } catch {}
  if (pingFile) await rm(pingFile, { force: true }).catch(() => {});
  if (boomFile) await rm(boomFile, { force: true }).catch(() => {});
  if (proc && proc.exitCode === null) {
    proc.kill('SIGTERM');
    await Promise.race([
      new Promise((res) => proc.once('exit', res)),
      sleep(2000),
    ]);
    if (proc.exitCode === null) proc.kill('SIGKILL');
  }
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
}

main()
  .catch((err) => {
    console.error('smoke run failed:', err);
    process.exitCode = 1;
  })
  .finally(cleanup);
