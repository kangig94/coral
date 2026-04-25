import type { Database } from 'better-sqlite3';

import { kbRoot } from "./paths.js";
import type { BuildFlavor } from '../infra/build-flavor.js';
import { createCurateScheduler, type CurateHandle } from './curate/scheduler.js';
import type { KbCorpusPublishCallbacks, KbRuntimeActivationSnapshot, KbRuntime } from './contracts.js';
import type { GitSyncRuntimePicks } from './curate/pipeline-types.js';
import { kbRuntimeDir } from './paths.js';
import { createKbRuntime } from './runtime.js';
import type { SpawnCliFn } from './curate/pipeline-types.js';
import type { Runtime } from '../runtime/ports.js';

export type KnowledgeBaseRuntime = {
  kb: KbRuntime;
  curateScheduler: CurateHandle;
};

export type CreateKbSubsystemOptions = {
  db: Database;
  pluginRoot: string;
  flavor: BuildFlavor;
  spawnCli: SpawnCliFn;
  getEquipmentView?: () => KbRuntimeActivationSnapshot | null;
  persistCorpusState?: KbCorpusPublishCallbacks['persistCorpusState'];
  notifyCorpusMutation?: KbCorpusPublishCallbacks['notifyCorpusMutation'];
  onCorpusPublishFailure?: KbCorpusPublishCallbacks['onPublishFailure'];
  onCorpusPublishSuccess?: KbCorpusPublishCallbacks['onPublishSuccess'];
} & GitSyncRuntimePicks;

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
  getEquipmentView,
  persistCorpusState,
  notifyCorpusMutation,
  onCorpusPublishFailure,
  onCorpusPublishSuccess,
}: CreateKbSubsystemOptions): Promise<KnowledgeBaseRuntime> {
  const kb = createKbRuntime({
    markdownRoot: kbRoot(flavor),
    runtimeDir: kbRuntimeDir(flavor),
    db,
    time: timePort,
    ids: idsPort,
    env: envPort,
    ...(getEquipmentView === undefined ? {} : { getEquipmentView }),
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
    curateScheduler,
  };
}

export type KbToolRuntime = {
  storage: Pick<Runtime['storage'], 'existsSync' | 'readFileSync'>;
};
