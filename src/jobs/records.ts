import type { JobContinuitySnapshot } from './continuity.js';
import type { JobDiagnostics, JobTerminal } from './terminal/result.js';
import type { ProviderContinuityBlob } from '../sessions/continuity.js';
import type { DurableCliRuntimeRecord } from '../runtime/durable-runtime.js';
import { type ProviderAction, type ProviderInstruction } from '../providers/contract.js';
import type { JobPhase } from './phase.js';
import type { SourceImportReadiness } from './launch.js';

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

export interface JobExit extends JobTerminal {
  diagnostics: JobDiagnostics;
  continuity?: JobContinuitySnapshot | null;
  endTime: string;
}

export interface JobStatus {
  jobId: string;
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
  continuity?: JobContinuitySnapshot | null;
}

export interface JobLaunch {
  jobId: string;
  sessionId: string | null;
  provider: string | null;
  projectRoot: string;
  backendNamespace: string;
  bundleHash?: string;
  jobKind: JobKind;
  pool: string;
  enqueueSequence: number;
  providerAction?: ProviderAction;
  operation?: 'kb.source_import' | 'kb.reindex';
  request: {
    prompt?: string;
    name?: string;
    model?: string;
    cwd?: string;
    effort?: string;
    bypassPermissions?: boolean;
    systemPrompt?: string;
    conversationRef?: string;
    instruction?: ProviderInstruction;
    coralEnv?: Record<string, string>;
    filePath?: string;
    slug?: string;
    readiness?: SourceImportReadiness;
  };
  parentWorkflowJobId?: string;
  workflowSlotId?: string;
  createdAt: string;
}

export interface AppServerRuntime {
  transport: 'app-server';
  startTime: string;
  providerMeta: {
    provider: string;
    leaseState: 'waiting' | 'acquired';
    serverGeneration?: number;
    providerContinuity?: ProviderContinuityBlob;
  };
}

export interface InternalJobRuntime {
  transport: 'internal';
  operation: 'kb.source_import' | 'kb.reindex';
  startTime: string;
}

export type JobRuntime = DurableCliRuntimeRecord | AppServerRuntime | InternalJobRuntime;

export function isAppServerRuntime(record: JobRuntime | null | undefined): record is AppServerRuntime {
  return record?.transport === 'app-server';
}

export interface JobProgress {
  jobId: string;
  sessionId: string | null;
  seq: number;
  type: 'progress' | 'terminal';
  ts: string;
  message?: string;
  result?: JobTerminal;
  continuity?: JobContinuitySnapshot | null;
}

/** Response shape for jobs.list. */
export type JobsListResponse = {
  jobs: Array<{ jobId: string; status: JobStatus }>;
};

/** Response shape for jobs.detail. Includes:
 *
 * - `status`: stable launch identity + lifecycle summary (phase, lastSeq,
 *   continuity, etc.)
 * - `events`: progress + terminal events for chain-walk rendering
 * - `readiness`: derived 4-way launch-readiness view (`'pending' | 'queued'
 *   | 'ready' | 'error'`) so callers can see whether a job has settled past
 *   its launch boundary without re-deriving from `phase` + `runtime`
 * - `exit`: the terminal record + per-job diagnostics (byteCounts, warnings,
 *   usage, processExit, progressFaults) and continuity snapshot when the
 *   job has terminated. `null` while the job is still live.
 */
export type JobDetailResponse = {
  status: JobStatus;
  events: JobProgress[];
  readiness: LaunchReadiness;
  exit: JobExit | null;
};

export type {
  JobDiagnostics,
  JobTerminal,
  JobTerminalDiagnostics,
  JobTerminalInput,
} from './terminal/result.js';
export { jobDiagnosticsSchema, normalizeJobTerminal } from './terminal/result.js';
