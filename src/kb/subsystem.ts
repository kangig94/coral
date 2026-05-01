import type { Database } from '../store/db.js';

import { createCurateScheduler, type CurateHandle } from './curate/scheduler.js';
import type { KbCorpusPublishCallbacks, KbRuntime } from './contract.js';
import { createKbRuntime } from './runtime.js';
import { asReadonlyDatabase, type ReadonlyDatabase } from '../store/read-port.js';
import type { SpawnCliFn } from './curate/spawn-cli.js';
import type { EnvPort, IdPort, ProcessPort, Runtime, StoragePort, TimePort } from '../runtime/ports.js';

export type KnowledgeBaseRuntime = {
  kb: KbRuntime;
  readDb: ReadonlyDatabase;
  curateScheduler: CurateHandle;
};

/**
 * Pre-composed KB paths. `markdownRoot` matches `runtime.paths.coral.corpus.kbRoot`
 * (the runtime composes the CORAL_KB_PATH override at construction time);
 * `runtimeDir` is the kb workspace where curate state files live. Both
 * arrive from the caller (coordinator) — the KB subsystem does not
 * recompute paths from flavor + env.
 */
export type KbSubsystemPaths = {
  markdownRoot: string;
  runtimeDir: string;
};

export type CreateKbSubsystemOptions = {
  db: Database;
  paths: KbSubsystemPaths;
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
  paths,
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
    markdownRoot: paths.markdownRoot,
    runtimeDir: paths.runtimeDir,
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
