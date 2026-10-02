import { createKbDaemonWriteRuntimeHost } from '#src/kb-daemon/runtime-host.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { decodeResolvedStoreEpoch } from '#src/store/epoch/index.js';

const baseDir = process.env.CORAL_TEST_BASE_DIR;
if (baseDir === undefined) throw new Error('store capability fixture input is unavailable');
const runtime = createRealRuntime('prod', { baseDir });
const store = decodeResolvedStoreEpoch(runtime, process.env.CORAL_KB_DAEMON_STORE);
if (store === undefined) throw new Error('store capability fixture input is unavailable');

async function main(): Promise<void> {
  const host = createKbDaemonWriteRuntimeHost({
    pluginRoot: process.cwd(),
    backendNamespace: 'store-capability-fixture',
    bundleHash: 'store-capability-fixture',
    curateUsageBudget: { isExhausted: async () => false },
    runtime,
    store,
  });

  try {
    const observation = await host.withKb(({ db }) => {
      const epoch = db.prepare<[], { epoch: string }>('SELECT epoch FROM epoch_marker').get()?.epoch ?? null;
      db.exec('CREATE TABLE daemon_marker (value TEXT NOT NULL)');
      db.prepare('INSERT INTO daemon_marker (value) VALUES (?)').run('opened-by-daemon');
      return { epoch };
    });
    process.stdout.write(`${JSON.stringify(observation)}\n`);
  } finally {
    await host.dispose();
  }
}

void main();
