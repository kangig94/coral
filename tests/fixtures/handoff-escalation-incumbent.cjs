const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const readline = require('node:readline');

const [, , socketPath, infoPath, armMarker] = process.argv;
if (!socketPath || !infoPath || !armMarker) throw new Error('Expected socket, discovery, and arm-marker paths');

let identity = null;
let pendingRequests = [];
let shutdownAccepted = false;

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function health() {
  if (identity === null) return null;
  return {
    status: 'ok',
    version: identity.version,
    bundleHash: identity.bundleHash,
    flavor: identity.flavor,
    namespace: identity.namespace,
    instanceId: identity.instanceId,
    pid: process.pid,
    incarnation: identity.incarnation,
  };
}

function respond(socket, request) {
  let result = null;
  if (request.method === 'transport.ping' || request.method === 'transport.health') {
    result = health();
  } else if (request.method === 'transport.shutdown') {
    shutdownAccepted = true;
    emit({ event: 'shutdown-accepted', pid: process.pid });
    result = { status: 'draining' };
  }
  socket.end(`${JSON.stringify({ kind: 'response', id: request.id, result })}\n`);
}

function dispatch(socket, request) {
  if (identity === null) {
    pendingRequests.push({ socket, request });
    emit({ event: 'request-blocked', method: request.method, count: pendingRequests.length });
    socket.once('close', () => {
      pendingRequests = pendingRequests.filter((pending) => pending.socket !== socket);
    });
    return;
  }
  respond(socket, request);
}

const server = net.createServer((socket) => {
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    const frames = buffer.split('\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      if (frame.trim().length === 0) continue;
      const request = JSON.parse(frame);
      if (request.kind === 'request') dispatch(socket, request);
    }
  });
});

function publish(nextIdentity) {
  identity = nextIdentity;
  fs.mkdirSync(path.dirname(infoPath), { recursive: true });
  const temporary = `${infoPath}.fixture-${process.pid}`;
  fs.writeFileSync(
    temporary,
    JSON.stringify({
      pid: process.pid,
      port: 1,
      socketPath,
      bundleHash: identity.bundleHash,
      flavor: identity.flavor,
      namespace: identity.namespace,
      startedAt: Date.now(),
      token: identity.token,
      bootToken: identity.bootToken,
      shutdownToken: identity.shutdownToken,
      version: identity.version,
      instanceId: identity.instanceId,
      incarnation: identity.incarnation,
    }),
  );
  fs.renameSync(temporary, infoPath);
  const waiting = pendingRequests;
  pendingRequests = [];
  for (const pending of waiting) {
    if (!pending.socket.destroyed) respond(pending.socket, pending.request);
  }
  emit({ event: 'published', pid: process.pid });
}

process.on('SIGTERM', () => {
  if (!shutdownAccepted) return;
  fs.writeFileSync(armMarker, 'armed');
  emit({ event: 'sigterm-armed', pid: process.pid });
});

const control = readline.createInterface({ input: process.stdin });
control.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.command === 'publish') {
    publish(message.identity);
  } else if (message.command === 'clear') {
    fs.rmSync(armMarker, { force: true });
    fs.rmSync(infoPath, { force: true });
    identity = null;
    emit({ event: 'cleared', pid: process.pid });
  } else if (message.command === 'stop') {
    server.close(() => process.exit(0));
  }
});

fs.mkdirSync(path.dirname(socketPath), { recursive: true });
server.listen(socketPath, () => emit({ event: 'listening', pid: process.pid }));
