import type { Database } from '../../store/db.js';
import { jobConversationProvider, type JobConversation } from './entry.js';
import { listProjectionConversationEntries, readProjectionJobConversation } from './projections.js';

type SessionLookupRef = {
  jobId: string;
  provider: string;
};

export interface SessionLookup {
  listSessionRefs(onInvalidRow?: (jobId: string | null, error: unknown) => void): SessionLookupRef[];
  readJobConversation(jobId: string): JobConversation | null;
}

export function createProjectionSessionLookup(db: Database): SessionLookup {
  return {
    listSessionRefs(onInvalidRow): SessionLookupRef[] {
      return listProjectionConversationEntries(db, undefined, undefined, onInvalidRow).map((entry) => ({
        jobId: entry.jobId,
        provider: jobConversationProvider(entry),
      }));
    },
    readJobConversation(jobId: string): JobConversation | null {
      return readProjectionJobConversation(db, jobId);
    },
  };
}
