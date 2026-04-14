import { errorMessage } from '../../shared/utils.js';
import { backendLog } from '../../shared/backend-log.js';
import type { RecoverPersistedDiscussFn } from '../lifecycle.js';
import type { RecoveredDiscussResume } from './operations.js';
import * as discussOperations from './operations.js';

export const recoverPersistedDiscuss: RecoverPersistedDiscussFn = async (deps) => {
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
