/**
 * Public client surface for coral consumers (coral-reef, external tools).
 *
 * IMPORT DISCIPLINE: Backend-side modules (src/execution/server.ts, etc.)
 * must import from specific client sub-modules (client/paths.js, client/readers.js),
 * NEVER from client/index.js — the barrel re-exports backend-lifecycle.ts which
 * contains import.meta.url, and esbuild would pull it into coral-backend.cjs
 * where it resolves to the bundle path.
 */

// ./paths.js
export {
  JOBS_DIR,
  SESSION_BASE,
  BACKEND_INFO_PATH,
  BACKEND_LOCK_PATH,
  discussBaseDir,
  discussDiscoveryPath,
  discussEventLogPath,
  syncHomePaths,
} from './paths.js';

// ./readers.js
export {
  readStatusRecord,
  readProgressLog,
  readSessionEntry,
  readSessionEntryLenient,
  readDiscussState,
  readDiscussEventLog,
  readDiscussDiscovery,
} from './readers.js';
export type {
  ProvenanceState,
  LenientSessionEntry,
  DiscussEventLogEntry,
  DiscussDiscoverySession,
  DiscussDiscoveryData,
} from './readers.js';

// ./backend-lifecycle.js
export { ensureBackend, withAbortTimeout } from './backend-lifecycle.js';
export type { BackendHandle } from './backend-lifecycle.js';

// ./http-client.js
export { BackendClient } from './http-client.js';
export type { CallerContext, BackendHealth } from './http-client.js';

// ../types.js
export type {
  PersistedStatusRecord,
  PersistedProgressRecord,
  WaitStreamEvent,
  WaitCursor,
  TerminalResult,
  LaunchDecision,
  JobPhase,
  SessionState,
  JobKind,
  WorkflowResultMeta,
  WorkflowStepMeta,
  UsageSummary,
} from '../types.js';

// ../execution/session-manager.js
export type { SessionEntry } from '../execution/session-manager.js';

// ../discuss/types.js
export type {
  DiscussState,
  TranscriptEntry,
  AgentState,
  EndReason,
} from '../discuss/types.js';
