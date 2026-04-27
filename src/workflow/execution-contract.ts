// Workflow execution contract: the port + value types that coordinator
// services consume to drive workflow runs. Lives at the workflow root next
// to other contract surfaces (events.ts, plan.ts) — the previous
// `workflow/internal/` directory implied private scope while the file was
// imported from four coordinator locations.
import type { AbortResult } from '../jobs/contracts/abort-registry.js';
import type { InvocationContext } from '../runtime/invocation-context.js';
import type { LaunchReadiness } from '../jobs/launch-readiness.js';
import type { WaitCursor, WaitStreamEvent, WaitStreamRequest } from '../jobs/wait.js';
import type { CauseRef } from '../causality/cause-ref.js';
import type { TerminalOutcome } from '../jobs/outcome.js';

export type StepDetail = {
  stepIndex: number;
  atomIndex: number;
  kind: 'agent' | 'prompt';
  label: string;
  provider: string;
  tagName: string;
  output: string;
};

export type PipelineResult = {
  finalOutput: string;
  stepDetails: StepDetail[];
};

export interface WorkflowSessionHandle {
  providerName: string;
  sessionId: string;
}

export interface CoralDispatchInput {
  prompt: string;
  sessionId?: string;
  jobId?: string;
  workflowSlotId?: string;
  cwd?: string;
  effort?: string;
  bypassPermissions?: boolean;
  systemPrompt?: string;
  parentWorkflowJobId?: string;
}

export interface ResumeInput {
  sessionId: string;
  prompt: string;
  jobId?: string;
  workflowSlotId?: string;
  name?: string;
  model?: string;
  pool?: string;
  cwd?: string;
  effort?: string;
  bypassPermissions?: boolean;
  systemPrompt?: string;
  instruction?: {
    content: string;
    channel: 'prompt' | 'system';
  };
  parentWorkflowJobId?: string;
}

export interface WorkflowExecutionPort {
  coralDispatch(providerName: string, coralName: string, input: CoralDispatchInput, ctx: InvocationContext): Promise<{
    status: 'running' | 'queued' | 'rejected';
    job?: string;
    session?: string;
    phase?: 'preflight';
    code?: string;
    message?: string;
  }>;
  resume(providerName: string, input: ResumeInput, ctx: InvocationContext): Promise<{
    status: 'running' | 'queued' | 'rejected';
    job?: string;
    session?: string;
    phase?: 'preflight';
    code?: string;
    message?: string;
  }>;
  abort(jobIds: string[]): AbortResult;
  awaitLaunch(jobId: string, timeoutMs: number): Promise<LaunchReadiness>;
  waitStream(req: WaitStreamRequest): AsyncGenerator<WaitStreamEvent>;
  waitForJobTerminal(jobId: string, timeoutMs?: number): Promise<void>;
  cleanupWorkflowSessions(sessions: readonly WorkflowSessionHandle[]): void;
}

export type LaunchedAtom = {
  slotId: string;
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
};

export type WaitFailure = {
  aborted: boolean;
  message: string;
  failedStep?: number;
  failedAtom?: string;
  failedJobId?: string;
  failedSlotId?: string;
  causeRef?: CauseRef;
  terminalOutcome?: TerminalOutcome;
};

export type WaitInternalState = {
  atoms: LaunchedAtom[];
  completedOutputs: Map<string, string>;
  cursor: WaitCursor;
  lastActivityAt: Map<string, number>;
  staleRetries: Map<string, number>;
  expectedStaleAborts: Set<string>;
  failureDrain?: {
    firstFailure: WaitFailure;
    abortRequested: boolean;
    drainDeadline: number;
  };
};

export class WorkflowExecutionError extends Error {
  readonly aborted: boolean;
  readonly stepDetails: StepDetail[];
  readonly failedStep?: number;
  readonly failedAtom?: string;
  readonly failedJobId?: string;
  readonly failedSlotId?: string;
  readonly causeRef?: CauseRef;
  readonly terminalOutcome?: TerminalOutcome;

  constructor(
    message: string,
    options: {
      aborted: boolean;
      stepDetails: StepDetail[];
      failedStep?: number;
      failedAtom?: string;
      failedJobId?: string;
      failedSlotId?: string;
      causeRef?: CauseRef;
      terminalOutcome?: TerminalOutcome;
    },
  ) {
    super(message);
    this.name = 'WorkflowExecutionError';
    this.aborted = options.aborted;
    this.stepDetails = [...options.stepDetails];
    this.failedStep = options.failedStep;
    this.failedAtom = options.failedAtom;
    this.failedJobId = options.failedJobId;
    this.failedSlotId = options.failedSlotId;
    this.causeRef = options.causeRef;
    this.terminalOutcome = options.terminalOutcome;
  }
}

export function buildStepDetailsForAtoms(atoms: LaunchedAtom[], results: Map<string, string>): StepDetail[] {
  const stepDetails: StepDetail[] = [];

  for (const atom of atoms) {
    const output = results.get(atom.atomKey);
    if (output === undefined) continue;
    stepDetails.push({
      stepIndex: atom.stepIndex,
      atomIndex: atom.atomIndex,
      kind: atom.kind,
      label: atom.agent,
      provider: atom.providerName,
      tagName: atom.tagName,
      output,
    });
  }

  return stepDetails;
}

export function createWorkflowExecutionError(
  message: string,
  aborted: boolean,
  stepDetails: StepDetail[],
  metadata?: Partial<WaitFailure>,
): WorkflowExecutionError {
  return new WorkflowExecutionError(message, {
    aborted,
    stepDetails,
    failedStep: metadata?.failedStep,
    failedAtom: metadata?.failedAtom,
    failedJobId: metadata?.failedJobId,
    failedSlotId: metadata?.failedSlotId,
    causeRef: metadata?.causeRef,
    terminalOutcome: metadata?.terminalOutcome,
  });
}

export function failureMetadata(metadata: Partial<WaitFailure>): Partial<WaitFailure> | undefined {
  if (
    metadata.failedStep === undefined
    && metadata.failedAtom === undefined
    && metadata.failedJobId === undefined
    && metadata.failedSlotId === undefined
    && metadata.causeRef === undefined
    && metadata.terminalOutcome === undefined
  ) {
    return undefined;
  }

  return {
    ...(metadata.failedStep !== undefined ? { failedStep: metadata.failedStep } : {}),
    ...(metadata.failedAtom !== undefined ? { failedAtom: metadata.failedAtom } : {}),
    ...(metadata.failedJobId !== undefined ? { failedJobId: metadata.failedJobId } : {}),
    ...(metadata.failedSlotId !== undefined ? { failedSlotId: metadata.failedSlotId } : {}),
    ...(metadata.causeRef !== undefined ? { causeRef: metadata.causeRef } : {}),
    ...(metadata.terminalOutcome !== undefined ? { terminalOutcome: metadata.terminalOutcome } : {}),
  };
}
