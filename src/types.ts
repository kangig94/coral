/**
 * Shared type definitions for the Coral plugin.
 */

export type { CodexExecResult, CodexThreadEvent, CodexThreadItem, CodexThreadItemDetails } from './providers/codex/types.js';
export type { ClaudeExecResult, ClaudeJsonOutput, ClaudeExecFailure } from './providers/claude/types.js';

// ── Execution Service contract types ─────────────────────────────────────────

/** Opaque identifier for a single job attempt. Used for wait/abort. */
export type JobId = string;

/** Opaque stable identifier for a session (conversation continuity). Used for list/resume/fork. */
export type SessionId = string;

/** Readiness state of a session entry. */
export type SessionState = 'pending' | 'ready' | 'non_resumable';

/** Lifecycle phase of a single job. */
export type JobPhase = 'queued' | 'launching' | 'running' | 'completed' | 'error' | 'aborted';

/** Bootstrap state surfaced by awaitLaunch(). */
export type LaunchState = 'pending' | 'queued' | 'ready' | 'busy' | 'error';

/** Progress event emitted by a Provider during execution. */
export interface ProviderProgressEvent {
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
  /** costUsd restructures the flat cost_usd / costUsd fields from current Claude results. */
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
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
  kind: 'agent' | 'prompt';
  provider: string;
  tagName: string;
  headingLine: number;
  line: number;
  endLine: number;
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
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
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
  jobKind?: JobKind;
  phase: JobPhase;
  launch: {
    state: LaunchState;
    message?: string;
    updatedAt: string;
  };
  result?: TerminalResult;
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
