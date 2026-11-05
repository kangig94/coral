import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer as createNetServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { decodeIpcErrorData } from '#src/transport/ipc/json-rpc.js';
import { attachInheritedIpcServer, createIpcServer } from '#src/transport/ipc/server.js';
import { createCoordinatorTransportAssembly } from '#src/coordinator/composition/transport-assembly.js';
import { createCoordinatorHealthReader } from '#src/coordinator/composition/health-observation.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { openWritableStoreDatabase } from '#src/store/db.js';
import { joinSuccessionWriterGeneration } from '#src/store/succession-writer-generation.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import type { HttpHandlerPorts } from '#src/transport/server-ports.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

const scenario = process.argv[2];
const pingCases =
  scenario === 'ping-assembly'
    ? (JSON.parse(process.argv[3]) as Array<{
        lifecycle: string;
        isDraining: boolean;
        incarnation: boolean;
        sentinel: boolean;
        expected: Record<string, unknown>;
      }>)
    : null;
const pingState = pingCases === null ? null : { ...pingCases[0] };
if (pingState?.sentinel) process.env.CORAL_SENTINEL_ID = 'test-sentinel';
const runtime = createRealRuntime('prod', { baseDir: process.env.HOME! });
const writer = joinSuccessionWriterGeneration(runtime, { storeRoot: join(process.env.HOME!, 'epochs'), epoch: '1' });
const opened = openWritableStoreDatabase({
  path: join(process.env.HOME!, 'store.db'),
  storage: runtime.storage,
  storeFormat: currentCoralStoreFormat(),
  flavor: runtime.flavor,
  writerEntitlement: writer,
});
assert.equal(opened.kind, 'opened');
if (opened.kind !== 'opened') throw new Error('store not opened');
const db = opened.db;
const cached = db.prepare('SELECT 1');
let inflight = 0;
let begins = 0;
let ends = 0;
let broken = true;
const logs: string[] = [];
const identity = {
  version: '1',
  bundleHash: 'hash',
  flavor: 'prod',
  namespace: 'test',
  instanceId: 'incumbent',
  token: 'token',
  bootToken: 'boot',
  now: () => 0,
  log: (line: string) => {
    logs.push(line);
    if (scenario === 'challenge-handoff-log' && line.includes('IPC socket task failure'))
      throw new Error('logger failed');
  },
};
const liveness = createCoordinatorHealthReader({
  runtime,
  world: { identity, backendPid: process.pid, idleTimer: { isDraining: true } },
  runtimeState: { getLifecycle: () => 'draining' },
  readSelfIncarnation: () => null,
} as unknown as Parameters<typeof createCoordinatorHealthReader>[0]).readLiveness;
const ports = {
  identity,
  coralEnvSnapshot: {},
  admin: {
    getLifecycleState() {
      if (scenario === 'lifecycle' && broken) throw new Error('lifecycle bug');
      return 'draining';
    },
    isLifecycleRunning: () => false,
    isDrainRequested: () => true,
    isLaunchFenceActive: () => false,
    beginRequest() {
      begins++;
      inflight++;
      if (scenario === 'admission' && broken) throw new Error('admission bug');
    },
    endRequest() {
      ends++;
      inflight--;
    },
    succession: async () => {
      if (scenario === 'succession-error' && broken) throw new Error('succession bug');
      return { kind: 'refused' };
    },
  },
  health: {
    read() {
      if (scenario === 'unexpected' && broken) throw new Error('diagnostic bug');
      if (scenario === 'cached') cached.get();
      else db.prepare('SELECT 1').get();
      return liveness();
    },
  },
} as unknown as HttpHandlerPorts;
const listener =
  pingState !== null
    ? createCoordinatorTransportAssembly({
        core: {
          runtime,
          identity,
          world: {
            identity,
            backendPid: process.pid,
            coralEnvSnapshot: {},
            idleTimer: {
              get isDraining() {
                return pingState.isDraining;
              },
              beginRequest: ports.admin.beginRequest,
              endRequest: ports.admin.endRequest,
            },
            storeServicesRef: {
              tryGet: () => ({
                progressStore: {
                  getDb: () => db,
                  listStoredNonterminalJobIds: () => [],
                  liveJobCount: () => 0,
                },
              }),
            },
          },
          state: {},
          runtimeState: {
            getLifecycle: () => pingState.lifecycle,
            getLaunchFenceActive: () => false,
            components: { list: () => [] },
          },
          kbDaemonSupervisor: { read: () => ({}) },
        },
        options: { getConsumerStuck: () => [] },
        execution: {
          defaults: { createServerFn: createServer },
          control: { isDrainRequested: () => pingState.isDraining },
          streamResponses: new Set(),
          eventStreamSubscriptions: new WeakMap(),
          services: {},
        },
        recovery: {},
        evidence: {},
        jobView: { readSelfIncarnation: () => (pingState.incarnation ? testIncarnation(123) : null) },
        successionAssembly: { succession: {} },
        requestPorts: { rpcPorts: {} },
      } as unknown as Parameters<typeof createCoordinatorTransportAssembly>[0]).ipcServer
    : createIpcServer(ports);
function socketDouble(fail = false) {
  const responses: unknown[] = [];
  const socket = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    resume() {},
    pause() {},
    read() {
      return null;
    },
    _handle: {
      readStop() {
        return 0;
      },
    },
    write(data: string) {
      if (scenario === 'write-throw' && broken) throw new Error('write failed');
      responses.push(JSON.parse(data));
      return true;
    },
    end() {
      if (fail) throw new Error('response end failed');
      socket.writableEnded = true;
      socket.destroy();
    },
    destroy() {
      if (!socket.destroyed) {
        socket.destroyed = true;
        socket.emit('close');
      }
    },
  });
  return { socket: socket as unknown as Socket, responses };
}
async function request(method: string, id: number, fail = false) {
  const { socket, responses } = socketDouble(fail);
  const frame = Buffer.from(
    JSON.stringify({ kind: 'request', id, method, params: {}, auth: { kind: 'boot', token: 'boot' } }) + '\n',
  );
  const closed = new Promise<void>((resolve) => socket.once('close', resolve));
  if (scenario === 'forwarded') {
    const previous = createIpcServer(ports);
    previous.forwardConnections!((transferred, pending) => listener.acceptSocket!(transferred, pending));
    previous.acceptSocket!(socket, frame.toString('base64'));
    assert.equal(previous.sockets.size, 0);
  } else if (scenario === 'inherited') {
    if (!listener.inheritedServer) attachInheritedIpcServer(listener, createNetServer(), '/unused.sock');
    listener.inheritedServer!.emit('connection', socket);
    socket.emit('data', frame);
  } else {
    listener.acceptSocket!(socket);
    socket.emit('data', frame);
  }
  await closed;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(responses.length, scenario === 'write-throw' && broken ? 0 : 1);
  assert.equal(inflight, 0);
  assert.equal(listener.sockets.size, 0);
  return responses[0] as { id: number; result?: unknown; error?: { data: { code: string }; message: string } };
}
writer.park();
if (pingCases !== null && pingState !== null) {
  const health = await request('transport.health', 40);
  assert.equal((decodeIpcErrorData(health.error?.data) as { code: string }).code, 'succession_writer_parked');
  for (const [index, testCase] of pingCases.entries()) {
    Object.assign(pingState, testCase);
    const response = await request('transport.ping', 41 + index);
    assert.equal(response.id, 41 + index);
    assert.deepEqual(response.result, {
      version: '1',
      bundleHash: 'hash',
      flavor: 'prod',
      namespace: 'test',
      instanceId: 'incumbent',
      pid: process.pid,
      ...testCase.expected,
    });
  }
  writer.unpark();
  const recovered = await request('transport.ping', 100);
  assert.equal(recovered.id, 100);
  assert(recovered.result);
} else if (scenario.startsWith('challenge-handoff')) {
  const { socket, responses } = socketDouble(true);
  const closed = new Promise<void>((resolve) => socket.once('close', resolve));
  Object.assign(ports, {
    childPrincipals: {
      issueChallenge: () => ({ challenge: 'challenge', incarnation: 'incarnation', namespace: 'test' }),
    },
  });
  listener.acceptSocket!(socket);
  socket.emit(
    'data',
    Buffer.from(JSON.stringify({ kind: 'request', id: 51, method: 'transport.challenge', params: {} }) + '\n'),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(responses.length, 1);
  assert.equal(socket.destroyed, false);
  listener.forwardConnections!(() => {
    throw new Error('Challenged socket must not transfer');
  });
  await closed;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert(logs.some((line) => line.includes('IPC socket task failure')));
  assert.equal(listener.sockets.size, 0);
  assert.equal(inflight, 0);
  assert.equal(begins, ends);
  assert.equal(responses.length, 2);
  assert.equal(
    (responses[1] as { error: { data: { code: string } } }).error.data.code,
    'child_reauthentication_required',
  );
} else {
  const method = scenario.startsWith('ping')
    ? 'transport.ping'
    : ['admission', 'counted-end', 'succession-error'].includes(scenario)
      ? 'coordinator.succession.v1.prepare'
      : 'transport.health';
  const response = await request(method, 41, scenario === 'write' || scenario === 'counted-end');
  if (scenario === 'write-throw') {
    assert(logs.some((line) => line.includes('write failed')));
  } else {
    assert.equal(response.id, 41);
    if (
      scenario === 'unexpected' ||
      scenario === 'lifecycle' ||
      scenario === 'admission' ||
      scenario === 'succession-error'
    ) {
      assert(response.error);
      assert(logs.some((line) => line.includes('bug')));
    } else if (scenario === 'counted-end') {
      assert(response.result);
      assert(logs.some((line) => line.includes('response end failed')));
    } else
      assert.equal((decodeIpcErrorData(response.error?.data) as { code: string }).code, 'succession_writer_parked');
    if (scenario === 'write') assert(logs.some((line) => line.includes('response end failed')));
  }
  if (['admission', 'counted-end', 'succession-error'].includes(scenario)) assert.equal(begins, 1);
  broken = false;
  writer.unpark();
  const recovered = await request('transport.health', 42);
  assert.equal(recovered.id, 42);
  assert(recovered.result);
  assert.equal(begins, ends);
}
db.close();
console.log('SURVIVED');
