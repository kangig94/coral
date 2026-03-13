/**
 * Public client surface for coral consumers (coral-reef, external tools).
 *
 * IMPORT DISCIPLINE: Backend-side modules (src/execution/server.ts, etc.)
 * must import from specific client sub-modules (client/paths.js, client/readers.js),
 * NEVER from client/index.js — the barrel re-exports backend-lifecycle.ts and
 * other client-facing helpers, so bundling it into coral-backend.cjs would
 * pull in code that the backend intentionally imports directly elsewhere.
 */

// ./paths.js
export {
  JOBS_DIR,
  sessionBase,
  pluginRootNamespace,
  installationDir,
  backendInfoPath,
  backendLockPath,
  discussBaseDir,
  discussDiscoveryPath,
  discussEventLogPath,
} from './paths.js';

// ./readers.js
export {
  readStatusRecord,
  readProgressLog,
  readSessionEntry,
  readSessionEntryLenient,
  readDiscussState,
  readDiscussSnapshot,
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

// ./discuss.js
export { buildDiscussDetail, buildDiscussSummary } from './discuss.js';
export type {
  DiscussAuthority,
  DiscussAuditDetailResponse,
  DiscussAuditSessionDto,
  DiscussAuditTranscriptEntryDto,
  DiscussControlBidsTranscriptEntryDto,
  DiscussControlDetailResponse,
  DiscussControlSessionDto,
  DiscussControlTranscriptEntryDto,
  DiscussDetailResponse,
  DiscussSummaryDto,
  DiscussView,
} from './discuss.js';

// ./backend-lifecycle.js
export { ensureBackend, withAbortTimeout } from './backend-lifecycle.js';
export type { BackendHandle } from './backend-lifecycle.js';

// ./http-client.js
export { BackendClient, BackendToolHttpError } from './http-client.js';
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
