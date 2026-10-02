const { createServer } = require('node:net');
const { spawn } = require('node:child_process');

if (process.argv[2] === 'incumbent') {
  const socketPath = process.argv[3];
  const server = createServer((socket) => socket.end('incumbent\n'));
  server.listen(socketPath, () => {
    const child = spawn(process.execPath, [__filename, 'successor'], {
      env: { ...process.env, EXIT_AFTER_RESPONSE: '1' },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    let sent = false;
    child.on('message', (message) => {
      if (message.kind === 'child-online' && !sent) {
        sent = true;
        child.send({ kind: 'listener', socketPath }, server, (error) => {
          if (error) throw error;
        });
      }
      if (message.kind === 'listener-accepted') process.send({ kind: 'transferred' });
    });
    process.on('message', (message) => {
      if (message.kind === 'exit') process.exit(0);
    });
  });
} else {
  const attemptId = process.argv[3] ?? 'fixture-parent';
  const parked = [];
  const park = (connection) => {
    connection.socket.pause();
    parked.push(connection);
    process.send({ kind: 'parked', attemptId });
  };
  const online = setInterval(() => process.send({ kind: 'child-online', attemptId }), 100);
  online.unref();
  process.on('message', (message, handle) => {
    if (message.kind === 'listener' && handle) {
      if (attemptId === 'fixture-parent') clearInterval(online);
      handle.on('connection', (socket) => {
        if (process.env.PARK_CONNECTIONS === '1') {
          park({ socket, socketPath: message.socketPath, pendingFrameBase64: '' });
          return;
        }
        socket.end('successor\n', () => {
          if (process.env.EXIT_AFTER_RESPONSE === '1') process.exit(0);
        });
      });
      process.send({ kind: 'listener-accepted', socketPath: message.socketPath });
    }
    if (message.kind === 'start' && process.env.DIE_BEFORE_LISTENER_ACK === '1') process.exit(1);
    if (message.kind === 'start') {
      clearInterval(online);
      process.send({ kind: 'listener-ready', attemptId: message.attemptId });
    }
    if (message.kind === 'listener' && message.attemptId && handle) {
      if (process.env.DIE_BEFORE_LISTENER_ACK === '1') process.exit(1);
      process.send({ kind: 'listener-accepted', attemptId: message.attemptId, socketPath: message.socketPath });
    }
    if (message.kind === 'listeners-complete') {
      process.send({ kind: 'listeners-accepted', attemptId: message.attemptId });
    }
    if (message.kind === 'writers-parked' && process.env.REPORT_OPEN_HOLD === '1') {
      process.send({ kind: 'ack', attemptId: message.attemptId, acknowledgment: { kind: 'hold', reason: 'open-failed' } });
    }
    if (message.kind === 'connection' && handle) {
      if (process.env.PARK_CONNECTIONS === '1') {
        park({ socket: handle, socketPath: message.socketPath, pendingFrameBase64: message.pendingFrameBase64 });
      } else handle.end('forwarded\n');
    }
    if (message.kind === 'abort' && process.env.PARK_CONNECTIONS === '1') {
      let remaining = parked.length;
      const released = () =>
        process.send({ kind: 'connections-released', attemptId: message.attemptId }, () => process.exit(1));
      if (remaining === 0) released();
      for (const { socket, ...addressed } of parked.splice(0)) {
        process.send({ kind: 'connection', attemptId: message.attemptId, ...addressed }, socket, () => {
          if (--remaining === 0) released();
        });
      }
    }
  });
  process.send({ kind: 'child-online', attemptId });
}
