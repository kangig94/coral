import { kbRoot } from '../infra/paths.js';
import { createCurateScheduler, type CurateHandle } from './curate/scheduler.js';
import type { KbCorpusPublishCallbacks, KbRuntime } from './contracts.js';
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
  pluginRoot: string;
  spawnCli: SpawnCliFn;
  persistCorpusState?: KbCorpusPublishCallbacks['persistCorpusState'];
  notifyCorpusMutation?: KbCorpusPublishCallbacks['notifyCorpusMutation'];
  onCorpusPublishFailure?: KbCorpusPublishCallbacks['onPublishFailure'];
  onCorpusPublishSuccess?: KbCorpusPublishCallbacks['onPublishSuccess'];
} & GitSyncRuntimePicks;

export async function createKbSubsystem({
  pluginRoot,
  spawnCli: spawnKbCli,
  processPort,
  storagePort,
  envPort,
  persistCorpusState,
  notifyCorpusMutation,
  onCorpusPublishFailure,
  onCorpusPublishSuccess,
}: CreateKbSubsystemOptions): Promise<KnowledgeBaseRuntime> {
  const kb = createKbRuntime({
    markdownRoot: kbRoot(),
    runtimeDir: kbRuntimeDir(),
  });
  if (persistCorpusState !== undefined && notifyCorpusMutation !== undefined) {
    kb.register({
      persistCorpusState,
      notifyCorpusMutation,
      ...(onCorpusPublishFailure === undefined ? {} : { onPublishFailure: onCorpusPublishFailure }),
      ...(onCorpusPublishSuccess === undefined ? {} : { onPublishSuccess: onCorpusPublishSuccess }),
    });
  }
  await kb.retryPendingCorpusPublication();
  await kb.withMutationLock(() => {
    kb.runEntrySeqUpgradeGuardIfNeeded();
  });
  await kb.initVectorStore(pluginRoot);

  const curateScheduler = createCurateScheduler({
    kb,
    spawnCli: spawnKbCli,
    processPort,
    storagePort,
    envPort,
  });

  await curateScheduler.start();

  return {
    kb,
    curateScheduler,
  };
}

export type KbToolRuntime = {
  storage: Pick<Runtime['storage'], 'existsSync' | 'readFileSync'>;
};
