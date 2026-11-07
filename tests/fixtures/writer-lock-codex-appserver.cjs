const fs = require('node:fs');
const readline = require('node:readline');

const lockPath = process.argv[2];
let lock = null;
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const release = () => {
  if (lock === null) return;
  fs.closeSync(lock);
  lock = null;
  fs.unlinkSync(lockPath);
};

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  const reply = (result) => send({ id: message.id, result });
  switch (message.method) {
    case 'config/read':
      reply({ config: {} });
      break;
    case 'model/list':
      reply({ data: [], nextCursor: null });
      break;
    case 'thread/start':
    case 'thread/resume':
      try {
        lock = fs.openSync(lockPath, 'wx');
        fs.writeFileSync(lock, String(process.pid));
        reply({ thread: { id: 'thread-shared' } });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        send({ id: message.id, error: { code: -32600, message: 'thread thread-shared already has an active writer' } });
      }
      break;
    case 'turn/start':
      reply({ turn: { id: `turn-${process.pid}`, status: 'completed' } });
      break;
    case 'thread/unsubscribe':
      release();
      reply({ status: 'unsubscribed' });
      break;
    case 'fixture/state':
      reply({ loaded: lock !== null });
      break;
    default:
      send({ id: message.id, error: { code: -32601, message: 'unsupported method' } });
  }
}).on('close', release);

process.on('disconnect', () => {
  release();
  process.exit(0);
});
