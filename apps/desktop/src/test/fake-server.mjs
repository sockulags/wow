// A stand-in for the wow server, started by the main-process tests the way the desktop starts the
// real one: a child process with an IPC channel and WOW_HOME. It writes server.json, answers the
// few RPC methods the desktop uses, keeps settings and topic rows in memory, and stops on the
// desktop's shutdown message.
//
// FAKE_SERVER_MODE: unset = normal, `exit-early` = exit with code 3 before writing server.json,
// `ignore-shutdown` = keep running after the shutdown message.
// The test-only method `test.setRows {topic, rows}` replaces a topic's rows and pushes them.
import { randomBytes } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const home = process.env.WOW_HOME;
const mode = process.env.FAKE_SERVER_MODE ?? '';
if (mode === 'exit-early') {
  process.stderr.write('fake server failed on purpose\n');
  process.exit(3);
}

const token = randomBytes(16).toString('hex');
// FAKE_SERVER_SETTINGS: JSON object of global settings the server starts with.
const settings = new Map(Object.entries(JSON.parse(process.env.FAKE_SERVER_SETTINGS ?? '{}')));
const rows = new Map([
  ['workflows', []],
  ['workflowRuns', []],
  ['threads', []],
]);
const subscribers = new Map();
let nextSubscription = 1;

const settingRows = () => [...settings].map(([key, value]) => ({ key, value, scope: 'global' }));
const topicRows = (topic) => (topic === 'settings' ? settingRows() : (rows.get(topic) ?? []));
const push = (topic) => {
  for (const [id, entry] of subscribers)
    if (entry.topic === topic)
      entry.socket.send(JSON.stringify({ subscription: id, data: topicRows(topic) }));
};

const handlers = {
  'settings.resolve': () => [...settings].map(([key, value]) => ({ key, value, source: 'global' })),
  subscribe: ({ topic }, socket) => {
    const subscriptionId = `sub-${nextSubscription++}`;
    subscribers.set(subscriptionId, { topic, socket });
    return { subscriptionId, data: topicRows(topic) };
  },
  dispatch: ({ commandId, command }) => {
    if (command.type !== 'setting.set') throw new Error(`unsupported command ${command.type}`);
    settings.set(command.key, command.value);
    push('settings');
    return { commandId, duplicate: false, seqs: [1] };
  },
  'test.setRows': ({ topic, rows: next }) => {
    if (topic === 'settings') for (const row of next) settings.set(row.key, row.value);
    else rows.set(topic, next);
    push(topic);
    return { ok: true };
  },
};

const wss = new WebSocketServer({
  host: '127.0.0.1',
  port: 0,
  verifyClient: ({ req }, done) => {
    const given = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('token');
    if (given === token) done(true);
    else done(false, 401, 'Unauthorized');
  },
});
wss.on('connection', (socket) => {
  socket.on('message', (raw) => {
    const { id, method, params } = JSON.parse(String(raw));
    try {
      const handler = handlers[method];
      if (handler === undefined) throw new Error(`unknown method ${method}`);
      socket.send(JSON.stringify({ id, result: handler(params, socket) }));
    } catch (error) {
      socket.send(JSON.stringify({ id, error: { code: 'internal', message: error.message } }));
    }
  });
  socket.on('close', () => {
    for (const [id, entry] of subscribers) if (entry.socket === socket) subscribers.delete(id);
  });
});

const infoFile = path.join(home, 'server.json');
wss.on('listening', () => {
  const { port } = wss.address();
  writeFileSync(infoFile, JSON.stringify({ port, token, pid: process.pid, startedAt: 'now' }));
});

process.on('message', (message) => {
  if (message?.type !== 'wow:shutdown' || mode === 'ignore-shutdown') return;
  rmSync(infoFile, { force: true });
  for (const client of wss.clients) client.terminate();
  wss.close(() => process.exit(0));
});
