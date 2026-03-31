/**
 * Shared type definitions for the Coral plugin.
 */

// ── Execution Service contract types ─────────────────────────────────────────

/** Opaque identifier for a single job attempt. Used for wait/abort. */
export type JobId = string;

/** Opaque stable identifier for a session (conversation continuity). Used for list/resume/fork. */
export type SessionId = string;

/** Readiness state of a session entry. */
export type SessionState = 'pending' | 'ready' | 'non_resumable';

/** Lifecycle phase of a single job. */
export type JobPhase = 'queued' | 'launching' | 'running' | 'completed' | 'error' | 'aborted';

export function isLivePhase(phase: JobPhase | string): phase is Extract<JobPhase, 'queued' | 'launching' | 'running'> {
  return phase === 'queued' || phase === 'launching' || phase === 'running';
}

export function isTerminalPhase(
  phase: JobPhase | string,
): phase is Extract<JobPhase, 'completed' | 'error' | 'aborted'> {
  return phase === 'completed' || phase === 'error' || phase === 'aborted';
}

export function readBackendNamespace(status: PersistedStatusRecord): string | null {
  return typeof status.backendNamespace === 'string' && status.backendNamespace.length > 0
    ? status.backendNamespace
    : null;
}

export function belongsToNamespace(status: PersistedStatusRecord, namespace: string): boolean {
  return readBackendNamespace(status) === namespace;
}

/** Bootstrap state surfaced by awaitLaunch(). */
export type LaunchState = 'pending' | 'queued' | 'ready' | 'busy' | 'error';

/** Progress event emitted by a Provider during execution. */
export interface ProviderProgressEvent {
  jobId: string;
  message: string;
  ts: string;
}

/** Opaque provider-owned continuity data persisted by the execution layer. */
export type ProviderContinuityBlob = Record<string, unknown>;

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

/** Request from the Execution Service to a Provider adapter. */
export interface ProviderRequest {
  action: ProviderAction;
  sessionId: string;
  name?: string;
  /** Provider-native conversation/thread reference for resume/fork. Internal only. */
  conversationRef?: string;
  prompt: string;
  model?: string;
  cwd?: string;
  effort?: string;
  bypassPermissions: boolean;
  /** User-facing system prompt from MCP tool schema (Claude: --append-system-prompt). */
  systemPrompt?: string;
  coralEnv: Record<string, string>;
  /**
   * Framework-injected instruction (coral dispatch / workflow).
   * When both systemPrompt and instruction are present, instruction takes precedence
   * and systemPrompt is appended after it in the same channel.
   */
  instruction?: ProviderInstruction;
}

/** Result returned by a Provider adapter after execution completes. */
export interface ProviderResult {
  content: string;
  conversationRef?: string;
  model?: string;
  durationMs?: number;
  aborted?: boolean;
  nonResumable?: boolean;
  exitCode?: number | null;
  notice?: string;
  errors?: unknown[];
  warnings?: string[];
  usage?: UsageSummary;
}

/**
 * Synchronous decision returned by ExecutionService.start/resume/fork.
 * Preflight failures are typed rejections; all other accepted launches return 'running'.
 */
export type LaunchDecision =
  | { status: 'running'; job: string; session: string }
  | { status: 'queued'; job: string; session: string; message?: undefined }
  | { status: 'rejected'; phase: 'preflight'; code: string; message: string };

/** Terminal result payload included in WaitStreamEvent and PersistedStatusRecord. */
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

export type JobKind = 'provider' | 'workflow';

export interface TerminalResult {
  content: string;
  durationMs?: number;
  aborted?: boolean;
  nonResumable?: boolean;
  exitCode?: number | null;
  notice?: string;
  errors?: unknown[];
  warnings?: string[];
  usage?: UsageSummary;
  workflow?: WorkflowResultMeta;
}

/** Opaque serializable replay cursor carried in SSE Last-Event-ID. */
export type WaitCursor = {
  jobs: Record<string, number>; // jobId -> last delivered eventId
};

/** Durable status record persisted in status.json for each job. */
export interface PersistedStatusRecord {
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
  result?: TerminalResult;
}

/** Durable launch record written before queue admission. Contains all data needed to reproduce the job after restart. */
export interface PersistedLaunchRecord {
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
    cwd?: string;
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
export type PersistedRuntimeRecord = DurableCliRuntimeRecord | AppServerRuntimeRecord;

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
  record: PersistedRuntimeRecord | null | undefined,
): record is DurableCliRuntimeRecord {
  return record !== null && record !== undefined && record.transport !== 'app-server';
}

export function isAppServerRuntime(
  record: PersistedRuntimeRecord | null | undefined,
): record is AppServerRuntimeRecord {
  return record?.transport === 'app-server';
}

/** Durable completion sentinel written after output flush and exit. */
export interface PersistedExitRecord {
  exitCode: number | null;
  signal: string | null;
  endTime: string;
}

/** Workflow coordinator checkpoint for active-step resume. */
export interface WorkflowCheckpoint {
  jobId: string;
  sessionId: string;
  provider: string;
  stepIndex: number;
  stepPrompt: string;
  atoms: Array<{
    jobId: string;
    sessionId: string;
    providerName: string;
    coralOp: string;
    agent: string;
    tagName: string;
    stepIndex: number;
    atomIndex: number;
    atomKey: string;
    kind: 'agent' | 'prompt';
  }>;
  completedOutputs: Record<string, string>; // atomKey -> output
  completedStepDetails: Array<{
    stepIndex: number;
    atomIndex: number;
    kind: 'agent' | 'prompt';
    label: string;
    provider: string;
    tagName: string;
    output: string;
  }>;
  cursor: Record<string, number>; // jobId -> last eventId
  lastActivityAt: Record<string, number>; // atomKey -> timestamp
  staleRetries: Record<string, number>; // atomKey -> retry count
  expectedStaleAborts: string[]; // jobIds
  failureDrain?: {
    firstFailureMessage: string;
    aborted: boolean;
    abortRequested: boolean;
    drainDeadline: number;
  };
  updatedAt: string;
}

/** Append-only progress record persisted in progress.jsonl. */
export interface PersistedProgressRecord {
  jobId: string;
  sessionId: string;
  eventId: number;
  type: 'progress' | 'terminal';
  ts: string;
  message?: string;
  result?: TerminalResult;
}

/** Request body for POST /wait/stream. */
export interface WaitRequest {
  jobIds: string[];
  timeoutSeconds?: number;
  cursor?: WaitCursor;
  projectRoot?: string;
}

/** Events emitted by the wait stream. */
export type WaitStreamEvent =
  | { type: 'progress'; jobId: string; sessionId: string; eventId: number; message: string }
  | {
      type: 'queued';
      jobId: string;
      sessionId: string;
      queuePosition: number;
      runningJobIds: string[];
    }
  | {
      type: 'terminal';
      completedJobId: string;
      sessionId: string;
      remainingJobIds: string[];
      resultPath: string;
      result: TerminalResult;
    }
  | { type: 'timeout'; runningJobIds: string[] };
