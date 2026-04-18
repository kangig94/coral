import { z } from 'zod';
import { JOB_PHASES, isLivePhase, isTerminalPhase, jobPhaseSchema, type JobPhase } from '../jobs/phase.js';
import { type TerminalOutcome, terminalOutcomeSchema } from '../jobs/outcome.js';
import type { ProviderContinuityBlob } from '../sessions/continuity.js';
import { type ProviderTurnOutcomeCompat, legacyTerminalOutcomeSchema } from './legacy-terminal-outcome-compat.js';

/**
 * Shared type definitions for the Coral plugin.
 */

export type { ProviderContinuityBlob } from '../sessions/continuity.js';
export type { SessionControllerProfile, SessionEntry, SessionState } from '../sessions/entry.js';

// ── Execution Service contract types ─────────────────────────────────────────

/** Opaque identifier for a single job attempt. Used for wait/abort. */
export type JobId = string;

/** Opaque stable identifier for a session (conversation continuity). Used for list/resume/fork. */
export type SessionId = string;

export { JOB_PHASES, jobPhaseSchema, isLivePhase, isTerminalPhase };
export type { JobPhase };

export function readBackendNamespace(status: JobStatusRecord): string | null {
  return typeof status.backendNamespace === 'string' && status.backendNamespace.length > 0
    ? status.backendNamespace
    : null;
}

export function belongsToNamespace(status: JobStatusRecord, namespace: string): boolean {
  return readBackendNamespace(status) === namespace;
}

/** Bootstrap state surfaced by awaitLaunch(). */
export type LaunchState = 'pending' | 'queued' | 'ready' | 'busy' | 'error';

/** Progress event emitted by a Provider during execution. */
export interface ProviderTurnProgressEvent {
  jobId: string;
  message: string;
  ts: string;
}

/** Provider action type — the three launch operations a provider handles. */
export type ProviderAction = 'exec' | 'resume' | 'fork';

/** Instruction injected by the framework (coral dispatch or workflow). */
export interface ProviderInstruction {
  content: string;
  /** 'system' maps to --append-system-prompt on Claude; both channels map to prompt prepend on Codex. */
  channel: 'prompt' | 'system';
}

export interface UsageSummary {
  inputTokens?: number;
  outputTokens?: number;
  /** costUsd restructures the flat cost_usd / costUsd fields from current Claude results. */
  costUsd?: number;
}

export const usageSummarySchema = z
  .object({
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    costUsd: z.number().optional(),
  })
  .strict();

/** Request from the Execution Service to a Provider adapter. */
export interface ProviderRequest {
  action: ProviderAction;
  sessionId: string;
  name?: string;
  /** Provider-native conversation/thread reference for resume/fork. Internal only. */
  conversationRef?: string;
  prompt: string;
  model?: string;
  cwd: string;
  /** Explicit caller-provided effort level. Adapters apply provider-specific
   *  env fallbacks (CORAL_{CLAUDE,CODEX}_EFFORT → CORAL_EFFORT → provider default)
   *  when this is undefined. */
  effort?: EffortLevel;
  bypassPermissions: boolean;
  /** User-facing system prompt passed through the backend to the provider adapter (Claude: --append-system-prompt). */
  systemPrompt?: string;
  coralEnv: Record<string, string>;
  /**
   * Framework-injected instruction (coral dispatch / workflow).
   * When both systemPrompt and instruction are present, instruction takes precedence
   * and systemPrompt is appended after it in the same channel.
   */
  instruction?: ProviderInstruction;
}

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Result returned by a Provider adapter after execution completes. */
export interface ProviderTurnResult {
  content: string;
  conversationRef?: string;
  model?: string;
  durationMs?: number;
  nonResumable?: boolean;
  exitCode?: number | null;
  warnings?: string[];
  usage?: UsageSummary;
  outcome: ProviderTurnOutcomeCompat;
}

/**
 * Synchronous decision returned by ExecutionService.start/resume/fork.
 * Preflight failures are typed rejections; all other accepted launches return 'running'.
 */
export type LaunchDecision =
  | { status: 'running'; job: string; session: string }
  | { status: 'queued'; job: string; session: string; message?: undefined }
  | { status: 'rejected'; phase: 'preflight'; code: string; message: string };

/** Terminal result payload included in WaitStreamEvent and JobStatusRecord. */
export interface WorkflowStepMeta {
  agent: string;
  step: number;
  atom: number;
  provider: string;
  start: number;
  end: number;
}

export interface WorkflowResultMeta {
  steps: WorkflowStepMeta[];
}

const workflowStepMetaSchema = z
  .object({
    agent: z.string(),
    step: z.number(),
    atom: z.number(),
    provider: z.string(),
    start: z.number(),
    end: z.number(),
  })
  .strict();

export const workflowResultMetaSchema = z
  .object({
    steps: z.array(workflowStepMetaSchema),
  })
  .strict();

export type JobKind = 'provider' | 'workflow';

export interface JobTerminalRecord {
  content: string;
  durationMs?: number;
  nonResumable?: boolean;
  exitCode?: number | null;
  warnings?: string[];
  usage?: UsageSummary;
  workflow?: WorkflowResultMeta;
  outcome: TerminalOutcome;
}

export const providerResultSchema = z
  .object({
    content: z.string(),
    conversationRef: z.string().optional(),
    model: z.string().optional(),
    durationMs: z.number().optional(),
    nonResumable: z.boolean().optional(),
    exitCode: z.number().nullable().optional(),
    warnings: z.array(z.string()).optional(),
    usage: usageSummarySchema.optional(),
    outcome: legacyTerminalOutcomeSchema,
  })
  .strict();

export const terminalResultSchema = z
  .object({
    content: z.string(),
    durationMs: z.number().optional(),
    nonResumable: z.boolean().optional(),
    exitCode: z.number().nullable().optional(),
    warnings: z.array(z.string()).optional(),
    usage: usageSummarySchema.optional(),
    workflow: workflowResultMetaSchema.optional(),
    outcome: terminalOutcomeSchema,
  })
  .strict();

/** Opaque serializable replay cursor carried in SSE Last-Event-ID. */
export type WaitCursor = {
  jobs: Record<string, number>; // jobId -> last delivered eventId
};

/** Durable status record persisted in status.json for each job. */
export interface JobStatusRecord {
  jobId: string;
  sessionId: string;
  provider: string;
  projectRoot: string;
  backendNamespace: string;
  bundleHash?: string;
  jobKind?: JobKind;
  phase: JobPhase;
  launch: {
    state: LaunchState;
    message?: string;
    updatedAt: string;
  };
  result?: JobTerminalRecord;
}

/** Durable launch record written before queue admission. Contains all data needed to reproduce the job after restart. */
export interface JobLaunchRecord {
  jobId: string;
  sessionId: string;
  provider: string;
  projectRoot: string;
  backendNamespace: string;
  bundleHash?: string;
  jobKind?: JobKind;
  pool: string; // LaunchPool as string for persistence
  enqueueSequence: number; // Monotonic counter for FIFO recovery ordering
  providerAction: ProviderAction;
  /** Normalized request fields needed to reproduce the launch. */
  request: {
    prompt: string;
    name?: string;
    model?: string;
    cwd: string;
    effort?: string;
    bypassPermissions: boolean;
    systemPrompt?: string;
    conversationRef?: string;
    instruction?: ProviderInstruction;
    coralEnv: Record<string, string>;
  };
  /** Parent workflow job ID — set when this job is an atom launched by a workflow coordinator. */
  parentWorkflowJobId?: string;
  createdAt: string;
}

/** Durable runtime record written by the wrapper after spawn succeeds. */
export type JobRuntimeRecord = DurableCliRuntimeRecord | AppServerRuntimeRecord;

export interface DurableCliRuntimeRecord {
  transport?: 'durable-cli';
  pid: number;
  stdoutPath: string;
  stderrPath: string;
  startTime: string;
  /** Provider-specific recovery metadata for reattaching live progress. */
  providerMeta?: Record<string, unknown>;
  /** Byte offset watermark for stable tail replay without duplicated progress. */
  tailWatermark?: number;
}

/** Durable runtime record written before an app-server lease is granted. */
export interface AppServerRuntimeRecord {
  transport: 'app-server';
  startTime: string;
  providerMeta: {
    provider: string;
    leaseState: 'waiting' | 'acquired';
    serverGeneration?: number;
    providerContinuity?: ProviderContinuityBlob;
    recoveryPolicy: 'session_continuity_only';
  };
}

export function isDurableCliRuntime(
  record: JobRuntimeRecord | null | undefined,
): record is DurableCliRuntimeRecord {
  return record !== null && record !== undefined && record.transport !== 'app-server';
}

export function isAppServerRuntime(
  record: JobRuntimeRecord | null | undefined,
): record is AppServerRuntimeRecord {
  return record?.transport === 'app-server';
}

/** Durable completion sentinel written after output flush and exit. */
export interface JobExitRecord {
  exitCode: number | null;
  signal: string | null;
  endTime: string;
}

/** Append-only progress record persisted in progress.jsonl. */
export interface JobProgressRecord {
  jobId: string;
  sessionId: string;
  eventId: number;
  type: 'progress' | 'terminal';
  ts: string;
  message?: string;
  result?: JobTerminalRecord;
}

/** Request body for POST /wait/stream. */
export interface WaitRequest {
  jobIds: string[];
  timeoutSeconds?: number;
  projectRoot?: string;
}

/** Internal wait-stream request with optional replay cursor state. */
export interface WaitStreamRequest extends WaitRequest {
  cursor?: WaitCursor;
}

/** Events emitted by the wait stream. */
export type WaitStreamEvent =
  | { type: 'progress'; jobId: string; eventId: number; message: string }
  | {
      type: 'queued';
      jobId: string;
      sessionId: string;
      queuePosition: number;
      runningJobIds: string[];
    }
  | {
      type: 'terminal';
      jobId: string;
      remainingJobIds: string[];
      resultPath: string;
      result: JobTerminalRecord;
    }
  | { type: 'waiting'; waitingJobIds: string[] };
