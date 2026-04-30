import type { Database } from 'better-sqlite3';

import { kbRoot } from './paths.js';
import type { BuildFlavor } from '../infra/build-flavor.js';
import { createCurateScheduler, type CurateHandle } from './curate/scheduler.js';
import type { KbCorpusPublishCallbacks, KbRuntime } from './contract.js';
import { kbRuntimeDir } from './paths.js';
import { createKbRuntime } from './runtime.js';
import { asReadonlyDatabase, type ReadonlyDatabase } from '../store/read-port.js';
import type { SpawnCliFn } from './curate/spawn-cli.js';
import type { EnvPort, IdPort, ProcessPort, Runtime, StoragePort, TimePort } from '../runtime/ports.js';

export type KnowledgeBaseRuntime = {
  kb: KbRuntime;
  readDb: ReadonlyDatabase;
  curateScheduler: CurateHandle;
};

export type CreateKbSubsystemOptions = {
  db: Database;
  pluginRoot: string;
  flavor: BuildFlavor;
  spawnCli: SpawnCliFn;
  processPort: ProcessPort;
  storagePort: StoragePort;
  envPort: EnvPort;
  idsPort: Pick<IdPort, 'uuid'>;
  timePort: Pick<TimePort, 'now' | 'setTimeout' | 'clearTimeout'>;
  persistCorpusState?: KbCorpusPublishCallbacks['persistCorpusState'];
  notifyCorpusMutation?: KbCorpusPublishCallbacks['notifyCorpusMutation'];
  onCorpusPublishFailure?: KbCorpusPublishCallbacks['onPublishFailure'];
  onCorpusPublishSuccess?: KbCorpusPublishCallbacks['onPublishSuccess'];
};

export async function createKbSubsystem({
  db,
  pluginRoot,
  flavor,
  spawnCli: spawnKbCli,
  processPort,
  storagePort,
  envPort,
  timePort,
  idsPort,
  persistCorpusState,
  notifyCorpusMutation,
  onCorpusPublishFailure,
  onCorpusPublishSuccess,
}: CreateKbSubsystemOptions): Promise<KnowledgeBaseRuntime> {
  const kb = createKbRuntime({
    markdownRoot: kbRoot(flavor, envPort.get('CORAL_KB_PATH')),
    runtimeDir: kbRuntimeDir(flavor),
    db,
    time: timePort,
    ids: idsPort,
    envPort,
    storage: storagePort,
    spawnCli: spawnKbCli,
    processPort,
  });
  if (persistCorpusState !== undefined && notifyCorpusMutation !== undefined) {
    kb.register({
      persistCorpusState,
      notifyCorpusMutation,
      ...(onCorpusPublishFailure === undefined ? {} : { onPublishFailure: onCorpusPublishFailure }),
      ...(onCorpusPublishSuccess === undefined ? {} : { onPublishSuccess: onCorpusPublishSuccess }),
    });
  }
  void pluginRoot;

  const curateScheduler = createCurateScheduler({
    kb,
    spawnCli: spawnKbCli,
    processPort,
    storagePort,
    envPort,
  });

  return {
    kb,
    readDb: asReadonlyDatabase(db),
    curateScheduler,
  };
}

export type KbToolRuntime = {
  storage: Pick<
    Runtime['storage'],
    | 'existsSync'
    | 'readFileSync'
    | 'readdirSync'
    | 'statSync'
    | 'mkdirSync'
    | 'writeFileSync'
    | 'renameSync'
    | 'rmSync'
    | 'unlinkSync'
  >;
  ids: Pick<Runtime['ids'], 'uuid'>;
  time: Pick<TimePort, 'now'>;
};
