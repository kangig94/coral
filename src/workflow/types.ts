import type { CallerContext } from '../execution/request-context.js';
import type { AbortResult } from '../execution/abort-registry.js';
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

export interface WorkflowExecutionPort {
  coralDispatch(providerName: string, coralName: string, input: CoralDispatchInput, ctx: CallerContext): Promise<LaunchDecision>;
  resume(providerName: string, input: ResumeInput, ctx: CallerContext): Promise<LaunchDecision>;
  abort(jobIds: string[]): AbortResult;
  awaitLaunch(jobId: string, timeoutMs: number): Promise<LaunchState>;
  waitStream(req: WaitRequest): AsyncGenerator<WaitStreamEvent>;
  getConversationRef(providerName: string, sessionId: string): string | undefined;
  waitForJobTerminal(jobId: string, timeoutMs?: number): Promise<void>;
}
