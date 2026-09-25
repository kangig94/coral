#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

if (process.argv[2] === 'app-server' && process.argv[3] === '--help') {
  process.stdout.write('fake codex app-server\n');
  process.exit(0);
}
if (process.argv[2] !== 'app-server') process.exit(1);

const state = path.join(process.env.HOME, '.fake-codex-state');
let nextThread = 0;
let threadId = '';

const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const complete = (id, turnId) => {
  send({
    method: 'item/completed',
    params: { threadId, turnId, item: { type: 'agentMessage', phase: 'final_answer', text: 'done' } },
  });
  send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
  fs.writeFileSync(path.join(state, 'terminal-' + id), 'done');
};
const waitForGate = (id, turnId) => {
  if (fs.existsSync(path.join(state, 'release-job'))) return complete(id, turnId);
  setTimeout(() => waitForGate(id, turnId), 10);
};

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  switch (message.method) {
    case 'initialize':
      send({ id: message.id, result: {} });
      break;
    case 'config/read':
      send({ id: message.id, result: { config: {} } });
      break;
    case 'thread/start':
      threadId = 'thread-' + ++nextThread;
      send({ method: 'thread/started', params: { thread: { id: threadId } } });
      send({ id: message.id, result: { thread: { id: threadId } } });
      break;
    case 'turn/start': {
      const turnId = 'turn-' + message.id;
      send({ method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress' } } });
      send({ id: message.id, result: { turn: { id: turnId, status: 'inProgress' } } });
      fs.writeFileSync(path.join(state, 'job-running'), 'running');
      waitForGate(message.id, turnId);
      break;
    }
    case 'turn/interrupt':
      send({ id: message.id, result: {} });
      break;
    default:
      send({ id: message.id, error: { code: -32601, message: 'unsupported method' } });
  }
});
