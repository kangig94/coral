import type { JobProgressFault, TerminalOutcome, TerminalOutcomeInput } from './outcome.js';
import type { UsageSummary, ProviderAction, ProviderInstruction } from '../providers/contract.js';
import type { RetentionPolicy } from '../sessions/entry.js';
import type { DurableCliRuntimeRecord } from '../runtime/durable-runtime.js';
import type { JobPhase } from './phase.js';
import type { SourceImportReadiness } from './launch.js';
import type { DiscussionRunDescriptor } from './discussion-run.js';
import type { JobProgressTiming } from './event-bodies.js';
import type { ExecutionOwner } from '../runtime/execution-owner.js';
import type { LaunchPool } from './contracts/admission.js';

/**
 * Derived launch-readiness view of a job — a 4-way coarsening of `phase` +
 * `runtime` answering "has the launch settled, and how?". Used by the workflow
 * executor to decide whether to proceed past launch boundary, and surfaced in
 * `JobDetailResponse` for debugging surfaces (CLI `jobs detail`, coral-reef,
 * etc.). The pure derivation function lives at `./launch-readiness.ts`.
 */
export type LaunchReadiness = 'pending' | 'queued' | 'ready' | 'error';

export function belongsToNamespace(status: JobStatus, namespace: string): boolean {
  return (
    typeof status.backendNamespace === 'string' &&
    status.backendNamespace.length > 0 &&
    status.backendNamespace === namespace
  );
}

export type JobKind = 'provider' | 'workflow' | 'kb';

export function isWorkflowJobKind(kind: JobKind | null | undefined): kind is 'workflow' {
  return kind === 'workflow';
}

export interface JobTerminal {
  content: string;
  outcome: TerminalOutcome;
  durationMs: number;
}

export interface JobTerminalInput<Scope = never> {
  content: string;
  outcome: TerminalOutcomeInput<Scope>;
  durationMs: number;
}

export interface JobTerminalDiagnostics {
  warnings?: string[];
  usage?: UsageSummary;
  processExit?: {
    exitCode: number | null;
    signal: string | null;
  };
  /** Output byte counts captured by the provider, propagated by the
   * coordinator's terminal materializer. Surfaces in `coral-cli wait` /
   * `jobs detail` so operators can see job output size. */
  byteCounts?: {
    stdout: number;
    stderr: number;
  };
}

export interface JobDiagnostics extends JobTerminalDiagnostics {
  progressFaults: JobProgressFault[];
}

export function emptyJobDiagnostics(): JobDiagnostics {
  return { progressFaults: [] };
}

export interface JobExit extends JobTerminal {
  diagnostics: JobDiagnostics;
  endTime: string;
}

export interface JobStatus {
  jobId: string;
  owner: ExecutionOwner;
  sessionId: string | null;
  provider: string | null;
  projectRoot: string;
  backendNamespace: string;
  bundleHash?: string;
  jobKind: JobKind;
  phase: JobPhase;
  updatedAt: string;
  lastSeq?: number;
  result?: JobTerminal;
}

interface JobLaunchBase {
  jobId: string;
  owner: ExecutionOwner;
  sessionId: string | null;
  provider: string | null;
  projectRoot: string;
  backendNamespace: string;
  bundleHash?: string;
  pool: LaunchPool;
  enqueueSequence: number;
  createdAt: string;
  discussionRun?: DiscussionRunDescriptor;
  providerAction?: ProviderAction;
  operation?: 'kb.source_import' | 'kb.reindex' | 'kb.community_summary';
  parentWorkflowJobId?: string;
  workflowSlotId?: string;
  workflowSlotGeneration?: number;
  replacesWorkflowJobId?: string;
}

interface ProviderLaunchRequestRecord {
  prompt: string;
  cwd: string;
  bypassPermissions: boolean;
  coralEnv: Record<string, string>;
  name?: string;
  model?: string;
  effort?: string;
  systemPrompt?: string;
  instruction?: ProviderInstruction;
  retention?: RetentionPolicy;
}

export interface ProviderJobLaunch extends JobLaunchBase {
  jobKind: 'provider';
  discussionRun?: DiscussionRunDescriptor;
  sessionId: string;
  provider: string;
  providerAction: ProviderAction;
  operation?: never;
  request: ProviderLaunchRequestRecord;
  parentWorkflowJobId?: string;
  workflowSlotId?: string;
  workflowSlotGeneration?: number;
  replacesWorkflowJobId?: string;
}

export interface WorkflowJobLaunch extends JobLaunchBase {
  jobKind: 'workflow';
  sessionId: null;
  provider: null;
  discussionRun?: never;
  providerAction?: never;
  operation?: never;
  parentWorkflowJobId?: never;
  workflowSlotId?: never;
  workflowSlotGeneration?: never;
  replacesWorkflowJobId?: never;
  request: Pick<ProviderLaunchRequestRecord, 'prompt' | 'cwd' | 'bypassPermissions' | 'coralEnv'>;
}

interface KbJobLaunchBase extends JobLaunchBase {
  jobKind: 'kb';
  sessionId: null;
  provider: null;
  discussionRun?: never;
  providerAction?: never;
  parentWorkflowJobId?: never;
  workflowSlotId?: never;
  workflowSlotGeneration?: never;
  replacesWorkflowJobId?: never;
}

export interface KbSourceImportJobLaunch extends KbJobLaunchBase {
  operation: 'kb.source_import';
  request: {
    filePath: string;
    slug?: string;
    readiness: SourceImportReadiness;
  };
}

export interface KbReindexJobLaunch extends KbJobLaunchBase {
  operation: 'kb.reindex';
  request: Record<string, never>;
}

export interface KbCommunitySummaryJobLaunch extends KbJobLaunchBase {
  operation: 'kb.community_summary';
  request: Record<string, never>;
}

export type JobLaunch =
  | ProviderJobLaunch
  | WorkflowJobLaunch
  | KbSourceImportJobLaunch
  | KbReindexJobLaunch
  | KbCommunitySummaryJobLaunch;

export interface AppServerRuntime {
  transport: 'app-server';
  startTime: string;
  providerMeta: {
    provider: string;
    leaseState: 'waiting' | 'acquired';
    serverGeneration?: number;
    claudeTransport?: string;
  };
}

export interface InternalJobRuntime {
  transport: 'internal';
  operation: 'kb.source_import' | 'kb.reindex' | 'kb.community_summary';
  owner?: 'parent' | 'kb-daemon';
  startTime: string;
}

export interface WorkflowJobRuntime {
  transport: 'workflow';
  startTime: string;
}

export type JobRuntime = DurableCliRuntimeRecord | AppServerRuntime | InternalJobRuntime | WorkflowJobRuntime;

export function isAppServerRuntime(record: JobRuntime | null | undefined): record is AppServerRuntime {
  return record?.transport === 'app-server';
}

interface JobEventBase {
  jobId: string;
  sessionId: string | null;
  seq: number;
  ts: string;
}

export interface JobProgressEvent extends JobEventBase {
  type: 'progress';
  message: string;
  timing: JobProgressTiming;
}

export interface JobTerminalEvent extends JobEventBase {
  type: 'terminal';
  result: JobTerminal;
  usage?: UsageSummary;
}

export type JobEvent = JobProgressEvent | JobTerminalEvent;

/** Response shape for jobs.list. */
export type JobsListResponse = {
  jobs: Array<{ jobId: string; status: JobStatus }>;
};

/** Response shape for jobs.detail. Includes:
 *
 * - `status`: stable launch identity + lifecycle summary (phase, lastSeq, etc.)
 * - `events`: progress + terminal events for chain-walk rendering
 * - `readiness`: derived 4-way launch-readiness view (`'pending' | 'queued'
 *   | 'ready' | 'error'`) so callers can see whether a job has settled past
 *   its launch boundary without re-deriving from `phase` + `runtime`
 * - `exit`: the terminal record + per-job diagnostics (byteCounts, warnings,
 *   usage, processExit, progressFaults) when the job has terminated. `null`
 *   while the job is still live.
 */
export type JobDetailResponse = {
  status: JobStatus;
  events: JobEvent[];
  readiness: LaunchReadiness;
  exit: JobExit | null;
};
