import type { AbortResult } from '../shared/execution-contracts.js';
import type { CallerContext } from '../shared/request-context.js';
import type { LaunchDecision, LaunchState, ProviderInstruction, WaitRequest, WaitStreamEvent } from '../shared/types.js';

export type AgentAtom = {
  kind: 'agent';
  namespace?: string;
  agent: string;
  provider?: string;
};

export type PromptAtom = {
  kind: 'prompt';
  text: string;
  provider?: string;
};

export type PipeAtom = AgentAtom | PromptAtom;

export type PipeStep = PipeAtom[];

export type PipelineAST = PipeStep[];

export interface CoralDispatchInput {
  prompt: string;
  sessionId?: string;
  cwd?: string;
  effort?: string;
  bypassPermissions?: boolean;
  systemPrompt?: string;
  parentWorkflowJobId?: string;
}

export interface ResumeInput {
  sessionId: string;
  prompt: string;
  name?: string;
  model?: string;
  pool?: string;
  cwd?: string;
  effort?: string;
  bypassPermissions?: boolean;
  systemPrompt?: string;
  instruction?: ProviderInstruction;
  parentWorkflowJobId?: string;
}

export interface WorkflowSessionHandle {
  providerName: string;
  sessionId: string;
}

export interface WorkflowExecutionPort {
  coralDispatch(providerName: string, coralName: string, input: CoralDispatchInput, ctx: CallerContext): Promise<LaunchDecision>;
  resume(providerName: string, input: ResumeInput, ctx: CallerContext): Promise<LaunchDecision>;
  abort(jobIds: string[]): AbortResult;
  awaitLaunch(jobId: string, timeoutMs: number): Promise<LaunchState>;
  waitStream(req: WaitRequest): AsyncGenerator<WaitStreamEvent>;
  waitForJobTerminal(jobId: string, timeoutMs?: number): Promise<void>;
  /**
   * Dispatch post-workflow cleanup to each provider's `cleanupSessions` hook.
   * Fire-and-forget: cleanup runs asynchronously and failures surface only via `backendLog.warn`.
   */
  cleanupWorkflowSessions(sessions: readonly WorkflowSessionHandle[]): void;
}
