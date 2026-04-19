/**
 * Public client surface for coral consumers (coral-reef, external tools).
 *
 * IMPORT DISCIPLINE: Backend-side modules (src/coordinator/bootstrap.ts, etc.)
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
export type { DiscussEventLogEntry } from './readers.js';
export type { DiscussDiscoverySession, DiscussDiscoveryData } from '../shared/persistence-types.js';
export type { ProvenanceState } from '../shared/session-entry.js';

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

// ./backend-handle.js
export { resolveDiscoveredBackend, withAbortTimeout } from './backend-handle.js';
export type { BackendHandle } from './backend-handle.js';

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
  WorkflowLaunchResponse,
} from './http-client.js';

// Domain types
export type {
  JobStatusRecord,
  JobProgressRecord,
  JobTerminalRecord,
  JobKind,
  WorkflowResultMeta,
  WorkflowStepMeta,
} from '../jobs/records.js';
export type { WaitStreamEvent, WaitCursor } from '../jobs/wait.js';
export type { JobPhase } from '../jobs/phase.js';
export type { SessionEntry, SessionState } from '../sessions/entry.js';
export type { UsageSummary } from '../providers/protocol.js';

// ../discuss/session-types.js
export type { DiscussState, TranscriptEntry, AgentState, EndReason } from '../discuss/session-types.js';
