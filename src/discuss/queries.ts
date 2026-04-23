import { loadAttachedOrPersistedSnapshot } from './shell/persistence.js';
import {
  loadDiscussDetail,
  listDiscussSessions,
  type DiscussReadHelpersDeps,
} from './shell/session-read-service.js';

export const discussQueries = {
  get: loadDiscussDetail,
  list: listDiscussSessions,
  snapshot: loadAttachedOrPersistedSnapshot,
} as const;

export type { DiscussReadHelpersDeps };
