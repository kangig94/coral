/**
 * Public client surface for coral consumers (coral-reef, external tools).
 *
 * IMPORT DISCIPLINE: Backend-side modules (src/execution/server.ts, etc.)
 * must import from specific modules (infra/paths.js, client/readers.js),
 * NEVER from client/index.js — the barrel re-exports backend-lifecycle.ts and
 * other client-facing helpers, so bundling it into coral-backend.cjs would
 * pull in code that the backend intentionally imports directly elsewhere.
 */

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
  DiscussEventLogEntry,
  DiscussDiscoverySession,
  DiscussDiscoveryData,
} from './readers.js';
export type { ProvenanceState, LenientSessionEntry } from '../shared/session-entry.js';

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
export { BackendClient, BackendToolHttpError, isBackendHealth } from './http-client.js';
export type {
  AcceptedLaunchResponse,
  BackendHealth,
  CallerContext,
  JobDetailResponse,
  JobsListResponse,
  SessionCreateResponse,
  SessionForkResponse,
  SessionMessageResponse,
  SessionsListResponse,
  WorkflowLaunchResponse,
} from './http-client.js';

// ../shared/types.js
export type {
  PersistedStatusRecord,
  PersistedProgressRecord,
  SessionEntry,
  WaitStreamEvent,
  WaitCursor,
  TerminalResult,
  JobPhase,
  SessionState,
  JobKind,
  WorkflowResultMeta,
  WorkflowStepMeta,
  UsageSummary,
} from '../shared/types.js';

// ../discuss/types.js
export type { DiscussState, TranscriptEntry, AgentState, EndReason } from '../discuss/types.js';
