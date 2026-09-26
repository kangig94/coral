#!/usr/bin/env node
// A codex app-server whose gated turn reports progress before and after a controller transfer the test drives,
// then completes when released or ends interrupted when the controller asks it to.
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
let activeTurn = null;
let emittedAfterTransfer = false;

const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const progress = (turnId, tool) =>
  send({
    method: 'item/started',
    params: { threadId, turnId, item: { type: 'dynamicToolCall', id: `item-${tool}`, tool, status: 'inProgress' } },
  });
const finish = (turnId, status) => {
  if (status === 'completed') {
    send({
      method: 'item/completed',
      params: { threadId, turnId, item: { type: 'agentMessage', phase: 'final_answer', text: 'done' } },
    });
  }
  send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status } } });
  fs.writeFileSync(path.join(state, `terminal-${status}`), turnId);
  activeTurn = null;
};
const poll = () => {
  if (activeTurn === null) return;
  if (!emittedAfterTransfer && fs.existsSync(path.join(state, 'emit-after-transfer'))) {
    emittedAfterTransfer = true;
    progress(activeTurn, 'after-transfer');
    fs.writeFileSync(path.join(state, 'emitted-after-transfer'), activeTurn);
  }
  if (fs.existsSync(path.join(state, 'release-job'))) {
    finish(activeTurn, 'completed');
    return;
  }
  setTimeout(poll, 20);
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
      activeTurn = turnId;
      send({ method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress' } } });
      send({ id: message.id, result: { turn: { id: turnId, status: 'inProgress' } } });
      // A warm-up turn completes at once and consumes its marker, leaving later turns gated.
      if (fs.existsSync(path.join(state, 'complete-next'))) {
        fs.unlinkSync(path.join(state, 'complete-next'));
        finish(turnId, 'completed');
        break;
      }
      progress(turnId, 'before-transfer');
      fs.writeFileSync(path.join(state, 'job-running'), String(process.pid));
      poll();
      break;
    }
    case 'turn/interrupt':
      send({ id: message.id, result: {} });
      if (activeTurn !== null) finish(activeTurn, 'interrupted');
      break;
    default:
      send({ id: message.id, error: { code: -32601, message: 'unsupported method' } });
  }
});
