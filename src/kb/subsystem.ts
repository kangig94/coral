import type { Database } from 'better-sqlite3';

import { kbRoot } from '../infra/paths.js';
import { createCurateScheduler, type CurateHandle } from './curate/scheduler.js';
import type { KbCorpusPublishCallbacks, KbRuntimeActivationSnapshot, KbRuntime } from './contracts.js';
import type { GitSyncRuntimePicks } from './curate/types.js';
import {
  kbRuntimeDir,
} from './paths.js';
import { createKbRuntime } from './runtime.js';
import type { SpawnCliFn } from '../coordinator/live/admission.js';
import type { Runtime } from '../runtime/ports.js';

export type KnowledgeBaseRuntime = {
  kb: KbRuntime;
  curateScheduler: CurateHandle;
};

export type CreateKbSubsystemOptions = {
  db?: Database;
  pluginRoot: string;
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
  spawnCli: spawnKbCli,
  processPort,
  storagePort,
  envPort,
  getEquipmentView,
  persistCorpusState,
  notifyCorpusMutation,
  onCorpusPublishFailure,
  onCorpusPublishSuccess,
}: CreateKbSubsystemOptions): Promise<KnowledgeBaseRuntime> {
  const kb = createKbRuntime({
    markdownRoot: kbRoot(),
    runtimeDir: kbRuntimeDir(),
    ...(getEquipmentView === undefined ? {} : { getEquipmentView }),
    ...(db === undefined ? {} : { db }),
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
