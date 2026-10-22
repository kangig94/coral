import { z } from 'zod';
import type { ResultAvailability } from './terminal/export.js';
import type { JobProgressFault, TerminalOutcome, TerminalOutcomeInput } from './outcome.js';
import type { HostRef, UsageSummary, ProviderAction, ProviderInstruction } from '../providers/contract.js';
import type { RetentionPolicy } from './conversation/entry.js';
import type { DurableCliRuntimeRecord } from '../runtime/durable-runtime.js';
import type { JobPhase } from './phase.js';
import type { SourceImportReadiness } from './launch.js';
import type { DiscussionRunDescriptor } from './discussion-run.js';
import type { JobProgressTiming } from './event-bodies.js';
import type { ExecutionOwner } from '../runtime/execution-owner.js';
import type { CanonicalWorkDir } from '../runtime/canonical-work-dir.js';
import type { LaunchPool } from './contracts/admission.js';

/**
 * Derived launch-readiness view of a job — a 4-way coarsening of `phase` +
 * `runtime` answering "has the launch settled, and how?". Used by the workflow
 * executor to decide whether to proceed past launch boundary, and surfaced in
 * `JobDetailResponse` for debugging surfaces (CLI `jobs detail`, coral-reef,
 * etc.). The pure derivation function lives at `./launch-readiness.ts`.
 */
export type LaunchReadiness = 'pending' | 'queued' | 'ready' | 'error';

export const jobKindSchema = z.enum(['provider', 'workflow', 'kb']);
export type JobKind = z.infer<typeof jobKindSchema>;

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

export const executionRetryStatusSchema = z
  .object({
    stage: z.enum(['accept', 'finish']),
    kind: z.enum(['retrying', 'blocked']),
    reason: z.string(),
    successor: z.enum(['live-retry', 'recovery-quarantine', 'discard-issuer-release']),
  })
  .passthrough();
export type ExecutionRetryStatus = Readonly<z.infer<typeof executionRetryStatusSchema>>;

export interface JobStatus {
  jobId: string;
  execution: number | null;
  finishing?: boolean;
  finishingStatus?: ExecutionRetryStatus;
  owner: ExecutionOwner;
  sessionId: string | null;
  provider: string | null;
  projectRoot: string;
  workDir: CanonicalWorkDir | null;
  backendNamespace: string | null;
  bundleHash?: string;
  jobKind: JobKind;
  parentWorkflowJobId?: string;
  workflowSlotId?: string;
  phase: JobPhase;
  updatedAt: string;
  lastSeq?: number;
  result?: JobTerminal;
}

interface JobLaunchBase {
  jobId: string;
  execution: number;
  owner: ExecutionOwner;
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
  provider: string;
  providerAction: ProviderAction;
  operation?: never;
  request: ProviderLaunchRequestRecord;
  parentWorkflowJobId?: string;
  workflowSlotId?: string;
}

export interface WorkflowJobLaunch extends JobLaunchBase {
  jobKind: 'workflow';
  provider: null;
  discussionRun?: never;
  providerAction?: never;
  operation?: never;
  parentWorkflowJobId?: never;
  workflowSlotId?: never;
  request: Pick<ProviderLaunchRequestRecord, 'prompt' | 'cwd' | 'bypassPermissions' | 'coralEnv'>;
}

interface KbJobLaunchBase extends JobLaunchBase {
  jobKind: 'kb';
  provider: null;
  discussionRun?: never;
  providerAction?: never;
  parentWorkflowJobId?: never;
  workflowSlotId?: never;
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

export type AppServerRuntime =
  | {
      transport: 'app-server';
      startTime: string;
      providerMeta: {
        provider: string;
        leaseState: 'waiting';
      };
    }
  | {
      transport: 'app-server';
      startTime: string;
      providerMeta: {
        provider: string;
        leaseState: 'acquired';
        hostRef: HostRef;
      };
    };

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
  execution?: number;
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

export type JobsReleaseResult = {
  released: string[];
  unknown: string[];
  terminal: string[];
};

/** Response shape for jobs.list. */
export type JobsListResponse = {
  jobs: Array<{
    jobId: string;
    execution?: number | null;
    resultPath?: string | null;
    status: JobStatus;
    released?: boolean;
  }>;
};

export type JobDetailResponse = {
  executionAddressing?: 'lifetime';
  availability?: ResultAvailability;
  epochKey?: string;
  requestedSeq?: number;
  resultPath?: string;
  executions?: JobExecutionDetail[];
  status: JobStatus;
  events: JobEvent[];
  readiness: LaunchReadiness;
  exit: JobExit | null;
};

export type JobExecutionDetail = Pick<JobDetailResponse, 'status' | 'events' | 'readiness' | 'exit'> & {
  execution: number;
  requestedSeq: number;
  resultPath: string;
};
