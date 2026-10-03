import assert from 'node:assert/strict';
import { prepareOwnerObligations } from '#src/coordinator/succession/obligations.js';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRealRuntime } from '#src/runtime/real.js';
import { createKbDaemonSupervisor } from '#src/coordinator/live/kb-daemon-supervisor/index.js';
import { createLocalAuthoritySuccessionOwners } from '#src/coordinator/composition/succession-owners/local-authority.js';
import { openMemoryStoreDatabase } from '#src/store/db.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
class Child extends EventEmitter {
  pid = 246810;
  exitCode = null;
  signalCode = null;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill() {
    throw new Error('Already exited: no signal should be needed');
  }
}
async function main() {
  const child = new Child();
  const real = createRealRuntime('prod');
  let spawnCount = 0;
  const runtime = {
    ...real,
    process: {
      ...real.process,
      spawn: () => {
        spawnCount++;
        return child;
      },
      observeLiveness: () => (child.exitCode === null ? 'alive' : 'absent'),
    },
  };
  const supervisor = createKbDaemonSupervisor({
    runtime,
    pluginRoot: '/mock-plugin',
    entrypoint: '/mock-daemon',
    backendNamespace: 'test-ns',
    bundleHash: '0123456789abcdef',
  });
  const starting = supervisor.start();
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write(
    JSON.stringify({ type: 'coral.kb_daemon.ready', pid: child.pid, startedAt: Date.now(), readyAt: Date.now() }) +
      '\n',
  );
  assert.equal((await starting).phase, 'online');
  const db = openMemoryStoreDatabase(currentCoralStoreFormat());
  const owner = createLocalAuthoritySuccessionOwners({
    getProgressStore: () => ({ getDb: () => db }),
    kbDaemonSupervisor: supervisor,
  }).find((x) => x.id === 'kb-daemon');
  supervisor.listActiveKbJobsForSuccession = async () => ({ active: [] });
  assert.equal((await owner.classify('upgrade-attempt')).kind, 'completed');
  const read = supervisor.read;
  supervisor.read = () => ({ ...read(), phase: 'failed' });
  assert.equal(
    (await owner.classify('upgrade-attempt')).kind,
    'blocking',
    'A live failed child still owns KB authority',
  );
  supervisor.read = read;
  child.exitCode = 1;
  child.emit('exit', 1, null);
  child.emit('close', 1, null);
  console.log('after real supervisor close handler:', JSON.stringify(supervisor.read()));
  assert.equal(runtime.process.observeLiveness(child.pid), 'absent');
  assert.equal(db.prepare("SELECT count(*) n FROM projection_jobs WHERE job_kind='kb'").get().n, 0);
  for (let i = 0; i < 3; i++)
    console.log('upgrade reconciliation', i + 1, JSON.stringify(await owner.classify('upgrade-attempt')));
  console.log('daemon spawn count:', spawnCount);
  console.log(
    'production preparation gate:',
    JSON.stringify(
      await prepareOwnerObligations(
        [owner],
        'upgrade-attempt',
        { accepts: [], protocols: ['prepare'] },
        ['kb-daemon'],
        () => [],
      ),
    ),
  );
  const result = await owner.classify('upgrade-attempt');
  assert.equal(supervisor.read().phase, 'failed');
  assert.ok(supervisor.read().lastError, 'Failure diagnostics remain visible');
  supervisor.read = () => {
    const { childPresence, ...unknown } = read();
    return unknown;
  };
  assert.equal(
    (await owner.classify('upgrade-attempt')).kind,
    'blocking',
    'Unknown absence cannot authorize preparation',
  );
  supervisor.read = () => ({ ...read(), pendingRequests: 1 });
  assert.equal((await owner.classify('upgrade-attempt')).kind, 'blocking', 'Unsettled requests still block');
  supervisor.read = read;
  db.prepare(
    `INSERT INTO projection_jobs(job_id,execution_owner,phase,diagnostics,project_root,backend_namespace,job_kind,created_at,last_seq)
    VALUES ('unsettled-kb','{}','running','{}','/tmp','test-ns','kb','2026-10-03T00:00:00Z',1)`,
  ).run();
  assert.equal((await owner.classify('upgrade-attempt')).kind, 'blocking', 'Unsettled durable KB jobs still block');
  db.prepare("DELETE FROM projection_jobs WHERE job_id='unsettled-kb'").run();
  await supervisor.stop('probe-positive-control');
  console.log('after explicit stop:', JSON.stringify(await owner.classify('upgrade-attempt')));
  db.close();
  assert.equal(result.kind, 'completed', 'Confirmed absent KB daemon with no jobs must not block succession');
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
