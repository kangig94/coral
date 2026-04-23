import { errorMessage } from '../infra/error-format.js';
import { backendLog } from '../infra/backend-log.js';
import type { CallerContext } from '../transport/request-context.js';
import type { DiscussContext } from './shell/context.js';
import type { DiscussSessionStore } from './shell/session-store.js';
import type { RecoveredDiscussResume } from './shell/operations.js';
import * as discussOperations from './shell/operations.js';

export type DiscussStartupDeps = {
  readonly knownDiscussSources: () => Set<string>;
  readonly getDiscussStoreForSource: (source: string) => DiscussSessionStore;
  readonly getDiscussContext: (ctx: CallerContext) => DiscussContext;
  readonly createCallerContext: (projectRoot: string) => CallerContext;
  readonly assertStartupStillActive: () => void;
};

export type DiscussRunStartup = (deps: DiscussStartupDeps) => Promise<RecoveredDiscussResume[]>;

export const runStartup: DiscussRunStartup = async (deps) => {
  const recoveredDiscussResumes: RecoveredDiscussResume[] = [];

  for (const source of deps.knownDiscussSources()) {
    try {
      recoveredDiscussResumes.push(
        ...(await discussOperations.recoverPersistedSessionsFromStore(
          deps.getDiscussStoreForSource(source),
          (snapshot) => deps.getDiscussContext(deps.createCallerContext(snapshot.projectRoot)),
          (snapshot) => deps.createCallerContext(snapshot.projectRoot),
        )),
      );
    } catch (error: unknown) {
      backendLog.warn(`Discuss recovery failed for source ${source}: ${errorMessage(error)}`);
    }
    deps.assertStartupStillActive();
  }

  return recoveredDiscussResumes;
};

export const discussReconcile = { runStartup } as const;
