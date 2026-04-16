import type { WorkflowCheckpointWriter } from '../shared/execution-contracts.js';
import type { CallerContext } from '../shared/request-context.js';
import type { TerminalResult, WaitCursor, WaitStreamEvent, WorkflowCheckpoint } from '../shared/types.js';
import type { PipeAtom, PipelineAST, WorkflowExecutionPort, WorkflowSessionHandle } from './types.js';
import { truncate } from '../shared/format-progress.js';
import { errorMessage } from '../shared/utils.js';
import { backendLog } from '../shared/backend-log.js';

export const BOOTSTRAP_TIMEOUT_MS = 2_000;
export const SIBLING_DRAIN_TIMEOUT_MS = 15_000;

const DEFAULT_WAIT_POLL_INTERVAL_MS = 500;
const DEFAULT_STALE_TIMEOUT_MS = 900_000;
const MAX_STALE_RECOVERY_RETRIES = 2;
const STALE_ABORT_TIMEOUT_MS = 30_000;
const STALE_RESUME_PROMPT = 'Your previous execution timed out due to inactivity. Continue where you left off.';

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

type LaunchContext = {
  atom: PipeAtom;
  atomIndex: number;
  stepIndex: number;
  stepPrompt: string;
  context?: string;
  workDir?: string;
  defaultProviderName: string;
  executionSvc: WorkflowExecutionPort;
  ctx: CallerContext;
  signal?: AbortSignal;
  completedStepDetails: StepDetail[];
  /** Parent workflow job ID — persisted in atom launch records for restart recovery. */
  workflowJobId?: string;
};

export type LaunchedAtom = {
  jobId: string;
  sessionId: string;
  providerName: string;
  coralOp: string;
  agent: string;
  tagName: string;
  stepIndex: number;
  atomIndex: number;
  atomKey: string;
  kind: PipeAtom['kind'];
};

type WaitFailure = {
  aborted: boolean;
  message: string;
};

export class WorkflowExecutionError extends Error {
  readonly aborted: boolean;
  readonly stepDetails: StepDetail[];

  constructor(message: string, options: { aborted: boolean; stepDetails: StepDetail[] }) {
    super(message);
    this.name = 'WorkflowExecutionError';
    this.aborted = options.aborted;
    this.stepDetails = [...options.stepDetails];
  }
}

/** Simple async mutex — serializes access via a single Promise chain. */
function createAsyncMutex(): { acquire: () => Promise<() => void> } {
  let chain = Promise.resolve();
  return {
    acquire: () => {
      let release!: () => void;
      const next = new Promise<void>((resolve) => {
        release = resolve;
      });
      const wait = chain;
      chain = chain.then(() => next);
      return wait.then(() => release);
    },
  };
}

type CheckpointState = {
  sessionId: string;
  provider: string;
  stepIndex: number;
  stepPrompt: string;
  launchedAtoms: LaunchedAtom[];
  completedOutputs: Map<string, string>;
  completedStepDetails: StepDetail[];
  cursor: WaitCursor;
  lastActivityAt: Map<string, number>;
  staleRetries: Map<string, number>;
  expectedStaleAborts: Set<string>;
  failureDrain?: {
    firstFailureMessage: string;
    aborted: boolean;
    abortRequested: boolean;
    drainDeadline: number;
  };
};

type PersistCheckpoint = (
  stepIndex: number,
  stepPrompt: string,
  launchedAtoms: LaunchedAtom[],
  completedOutputs: Map<string, string>,
  cursor: WaitCursor,
  lastActivityAt: Map<string, number>,
  staleRetries: Map<string, number>,
  expectedStaleAborts: Set<string>,
  failureDrain?: CheckpointState['failureDrain'],
) => void;

/** Fire-and-forget checkpoint write, serialized through the mutex. */
function writeCheckpoint(
  progressStore: WorkflowCheckpointWriter,
  workflowJobId: string,
  mutex: ReturnType<typeof createAsyncMutex>,
  data: CheckpointState,
): void {
  void mutex
    .acquire()
    .then((release) => {
      try {
        const checkpoint: WorkflowCheckpoint = {
          jobId: workflowJobId,
          sessionId: data.sessionId,
          provider: data.provider,
          stepIndex: data.stepIndex,
          stepPrompt: data.stepPrompt,
          atoms: data.launchedAtoms.map((atom) => ({ ...atom })),
          completedOutputs: Object.fromEntries(data.completedOutputs),
          completedStepDetails: [...data.completedStepDetails],
          cursor: { ...data.cursor.jobs },
          lastActivityAt: Object.fromEntries(data.lastActivityAt),
          staleRetries: Object.fromEntries(data.staleRetries),
          expectedStaleAborts: [...data.expectedStaleAborts],
          failureDrain: data.failureDrain,
          updatedAt: new Date().toISOString(),
        };
        progressStore.writeWorkflowCheckpoint(workflowJobId, checkpoint);
      } finally {
        release();
      }
    })
    .catch((e: unknown) => { backendLog.warn(`Checkpoint write failed for ${workflowJobId}: ${errorMessage(e)}`); });
}

function createCheckpointPersister(
  workflowJobId: string | undefined,
  progressStore: WorkflowCheckpointWriter | undefined,
  provider: string,
  sessionId: string,
  completedStepDetails: StepDetail[],
): PersistCheckpoint {
  if (workflowJobId === undefined || progressStore === undefined) {
    return () => {};
  }

  const checkpointMutex = createAsyncMutex();
  return (
    stepIndex,
    stepPrompt,
    launchedAtoms,
    completedOutputs,
    cursor,
    lastActivityAt,
    staleRetries,
    expectedStaleAborts,
    failureDrain,
  ) => {
    writeCheckpoint(progressStore, workflowJobId, checkpointMutex, {
      sessionId,
      provider,
      stepIndex,
      stepPrompt,
      launchedAtoms,
      completedOutputs,
      completedStepDetails,
      cursor,
      lastActivityAt,
      staleRetries,
      expectedStaleAborts,
      failureDrain,
    });
  };
}

function stripElapsedPrefix(message: string): string {
  if (!message.startsWith('[')) return message;
  const closeBracket = message.indexOf('] ');
  if (closeBracket < 0) return message;
  return message.slice(closeBracket + 2);
}

function atomTagName(atom: PipeAtom): string {
  return atom.kind === 'prompt' ? 'step-result' : atom.agent;
}

function atomDiagnosticLabel(atom: PipeAtom, atomIndex: number): string {
  if (atom.kind === 'agent') return atom.agent;
  const truncated = truncate(atom.text, 20);
  return `prompt#${atomIndex}(${truncated})`;
}

function formatAtomProgress(atom: LaunchedAtom, message: string): string {
  return `${atom.stepIndex}-${atom.agent.slice(0, 3)} ${message}`;
}

function describeTerminalFailure(result: TerminalResult): string {
  if (result.notice) {
    const notice = result.notice.trim();
    return notice.length > 0 ? notice : 'unknown error';
  }
  if (result.aborted) return 'aborted';
  const content = result.content.trim();
  return content.length > 0 ? content : 'unknown error';
}

function buildStepDetailsForAtoms(atoms: LaunchedAtom[], results: Map<string, string>): StepDetail[] {
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

function createWorkflowExecutionError(
  message: string,
  aborted: boolean,
  stepDetails: StepDetail[],
): WorkflowExecutionError {
  return new WorkflowExecutionError(message, { aborted, stepDetails });
}

function waitTimeoutSeconds(staleTimeoutMs: number, pollIntervalMs: number): number {
  const timeoutMs = staleTimeoutMs > 0 ? Math.min(staleTimeoutMs, pollIntervalMs) : pollIntervalMs;
  return Math.max(1, Math.ceil(timeoutMs / 1000));
}

async function readLaunchFailureMessage(
  jobId: string,
  executionSvc: WorkflowExecutionPort,
  signal?: AbortSignal,
): Promise<string | null> {
  if (signal?.aborted) return 'aborted during bootstrap';

  for await (const event of executionSvc.waitStream({ jobIds: [jobId], timeoutSeconds: 1 })) {
    if (event.type !== 'terminal') continue;
    return describeTerminalFailure(event.result);
  }

  return null;
}

export async function launchAtomWithRetry(context: LaunchContext): Promise<LaunchedAtom> {
  const {
    atom,
    atomIndex,
    stepIndex,
    stepPrompt,
    context: sharedContext,
    workDir,
    defaultProviderName,
    executionSvc,
    ctx,
    signal,
    completedStepDetails,
  } = context;
  const label = atomDiagnosticLabel(atom, atomIndex);
  const tagName = atomTagName(atom);
  const providerName = atom.provider ?? defaultProviderName;
  const atomKey = `${stepIndex}:${atomIndex}`;

  let coralName: string;
  let atomPrompt: string;

  if (atom.kind === 'agent') {
    const namespace = atom.namespace ?? 'coral';
    if (namespace !== 'coral') {
      throw new Error(`Step ${stepIndex}, atom '${label}' launch failed: unsupported namespace "${namespace}"`);
    }

    coralName = atom.agent;
    atomPrompt = [sharedContext, stepPrompt].filter(Boolean).join('\n\n');
  } else {
    coralName = 'workflow-literal';
    // First-step prompt literals use the literal as the instruction body; shared
    // context still prepends when present. Later prompt literals prepend the
    // literal before the previous step output so instruction comes first.
    if (stepIndex === 0) {
      atomPrompt = sharedContext ? `${sharedContext}\n\n${atom.text}` : atom.text;
    } else {
      atomPrompt = [sharedContext, atom.text, stepPrompt].filter(Boolean).join('\n\n');
    }
  }

  if (signal?.aborted) {
    throw createWorkflowExecutionError('Pipeline aborted (launched atoms may continue)', true, completedStepDetails);
  }

  const decision = await executionSvc.coralDispatch(
    providerName,
    coralName,
    {
      prompt: atomPrompt,
      cwd: workDir ?? ctx.projectRoot,
      parentWorkflowJobId: context.workflowJobId,
    },
    ctx,
  );

  if (decision.status === 'rejected') {
    throw new Error(`Step ${stepIndex}, atom '${label}' launch failed: ${decision.message}`);
  }

  const launchState = await executionSvc.awaitLaunch(decision.job, BOOTSTRAP_TIMEOUT_MS);
  if (launchState === 'error') {
    const message = await readLaunchFailureMessage(decision.job, executionSvc, signal);
    throw new Error(`Step ${stepIndex}, atom '${label}' failed: ${message ?? 'unknown error'}`);
  }

  return {
    jobId: decision.job,
    sessionId: decision.session,
    providerName,
    coralOp: `coral:${coralName}`,
    agent: label,
    tagName,
    stepIndex,
    atomIndex,
    atomKey,
    kind: atom.kind,
  };
}

export type WaitInternalState = {
  atoms: LaunchedAtom[];
  completedOutputs: Map<string, string>;
  cursor: WaitCursor;
  lastActivityAt: Map<string, number>;
  staleRetries: Map<string, number>;
  expectedStaleAborts: Set<string>;
  failureDrain?: {
    firstFailureMessage: string;
    aborted: boolean;
    abortRequested: boolean;
    drainDeadline: number;
  };
};

export type WaitForAtomsOptions = {
  signal?: AbortSignal;
  staleTimeoutMs: number;
  pollIntervalMs: number;
  workDir?: string;
  onProgress: (message: string) => void;
  completedStepDetails?: StepDetail[];
  onAtomTerminal?: (state: WaitInternalState) => void;
  onStaleSwap?: (state: WaitInternalState) => void;
};

type AwaitStepState = {
  pending: Map<string, LaunchedAtom>;
  results: Map<string, string>;
  cursor: WaitCursor;
  lastActivityAt: Map<string, number>;
  staleRetries: Map<string, number>;
  expectedStaleAborts: Set<string>;
  failureDrain: {
    firstFailure: WaitFailure;
    drainDeadline: number;
  } | null;
};

function createAwaitStepState(atoms: LaunchedAtom[]): AwaitStepState {
  const pending = new Map<string, LaunchedAtom>();
  const lastActivityAt = new Map<string, number>();
  const staleRetries = new Map<string, number>();
  const startedAt = Date.now();

  for (const atom of atoms) {
    pending.set(atom.jobId, atom);
    lastActivityAt.set(atom.atomKey, startedAt);
    staleRetries.set(atom.atomKey, 0);
  }

  return {
    pending,
    results: new Map(),
    cursor: { jobs: {} },
    lastActivityAt,
    staleRetries,
    expectedStaleAborts: new Set(),
    failureDrain: null,
  };
}

function snapshotWaitState(state: AwaitStepState): WaitInternalState {
  return {
    atoms: [...state.pending.values()],
    completedOutputs: state.results,
    cursor: state.cursor,
    lastActivityAt: state.lastActivityAt,
    staleRetries: state.staleRetries,
    expectedStaleAborts: state.expectedStaleAborts,
    failureDrain:
      state.failureDrain === null
        ? undefined
        : {
            firstFailureMessage: state.failureDrain.firstFailure.message,
            aborted: state.failureDrain.firstFailure.aborted,
            abortRequested: true,
            drainDeadline: state.failureDrain.drainDeadline,
          },
  };
}

function buildPartialStepDetails(
  atoms: LaunchedAtom[],
  completedStepDetails: StepDetail[],
  results: Map<string, string>,
): StepDetail[] {
  return [...completedStepDetails, ...buildStepDetailsForAtoms(atoms, results)];
}

function enterFailureDrain(
  state: AwaitStepState,
  executionSvc: WorkflowExecutionPort,
  failure: WaitFailure,
): void {
  if (state.failureDrain !== null) return;
  state.failureDrain = {
    firstFailure: failure,
    drainDeadline: Date.now() + SIBLING_DRAIN_TIMEOUT_MS,
  };
  executionSvc.abort([...state.pending.keys()]);
}

async function recoverStaleAtom(
  state: AwaitStepState,
  executionSvc: WorkflowExecutionPort,
  ctx: CallerContext,
  options: {
    signal?: AbortSignal;
    staleTimeoutMs: number;
    workDir?: string;
    onProgress: (message: string) => void;
    buildPartialStepDetails: () => StepDetail[];
  },
): Promise<boolean> {
  const now = Date.now();

  for (const atom of state.pending.values()) {
    const lastActive = state.lastActivityAt.get(atom.atomKey) ?? now;
    if (now - lastActive < options.staleTimeoutMs) continue;

    const retries = state.staleRetries.get(atom.atomKey) ?? 0;
    if (retries >= MAX_STALE_RECOVERY_RETRIES) {
      throw createWorkflowExecutionError(
        `Step ${atom.stepIndex}, atom '${atom.agent}' stale after ${retries} recovery attempts`,
        false,
        options.buildPartialStepDetails(),
      );
    }

    state.expectedStaleAborts.add(atom.jobId);
    options.onProgress(formatAtomProgress(atom, 'stale, aborting'));
    executionSvc.abort([atom.jobId]);

    try {
      await executionSvc.waitForJobTerminal(atom.jobId, STALE_ABORT_TIMEOUT_MS);
    } catch (error: unknown) {
      throw createWorkflowExecutionError(
        `Step ${atom.stepIndex}, atom '${atom.agent}' stale recovery abort failed: ${errorMessage(error)}`,
        false,
        options.buildPartialStepDetails(),
      );
    }

    if (options.signal?.aborted) {
      throw createWorkflowExecutionError(
        'Pipeline aborted (launched atoms may continue)',
        true,
        options.buildPartialStepDetails(),
      );
    }

    const resumed = await executionSvc.resume(
      atom.providerName,
      {
        sessionId: atom.sessionId,
        prompt: STALE_RESUME_PROMPT,
        cwd: options.workDir ?? ctx.projectRoot,
      },
      ctx,
    );

    if (resumed.status === 'rejected') {
      throw createWorkflowExecutionError(
        `Step ${atom.stepIndex}, atom '${atom.agent}' resume failed: ${resumed.message}`,
        false,
        options.buildPartialStepDetails(),
      );
    }

    const launchState = await executionSvc.awaitLaunch(resumed.job, BOOTSTRAP_TIMEOUT_MS);
    if (launchState === 'error') {
      const message = await readLaunchFailureMessage(resumed.job, executionSvc, options.signal);
      throw createWorkflowExecutionError(
        `Step ${atom.stepIndex}, atom '${atom.agent}' resume failed: ${message ?? 'unknown error'}`,
        false,
        options.buildPartialStepDetails(),
      );
    }

    state.pending.delete(atom.jobId);
    delete state.cursor.jobs[atom.jobId];
    state.pending.set(resumed.job, {
      ...atom,
      jobId: resumed.job,
      sessionId: resumed.session,
    });
    state.staleRetries.set(atom.atomKey, retries + 1);

    const resumedAt = Date.now();
    for (const sibling of state.pending.values()) {
      state.lastActivityAt.set(sibling.atomKey, resumedAt);
    }

    options.onProgress(formatAtomProgress(atom, 'resumed'));
    return true;
  }

  return false;
}

function handleWaitEvent(
  event: WaitStreamEvent,
  state: AwaitStepState,
  executionSvc: WorkflowExecutionPort,
  options: Pick<WaitForAtomsOptions, 'onProgress' | 'onAtomTerminal'>,
): 'handled' | 'check-stale' {
  switch (event.type) {
    case 'queued': {
      const atom = state.pending.get(event.jobId);
      if (!atom) return 'handled';
      state.lastActivityAt.set(atom.atomKey, Date.now());
      options.onProgress(formatAtomProgress(atom, `queued (position ${event.queuePosition})`));
      return 'handled';
    }

    case 'progress': {
      state.cursor.jobs[event.jobId] = event.eventId;
      const atom = state.pending.get(event.jobId);
      if (!atom) return 'handled';
      state.lastActivityAt.set(atom.atomKey, Date.now());
      options.onProgress(formatAtomProgress(atom, stripElapsedPrefix(event.message)));
      return 'handled';
    }

    case 'terminal': {
      const atom = state.pending.get(event.completedJobId);
      if (!atom) return 'handled';

      state.pending.delete(event.completedJobId);
      delete state.cursor.jobs[event.completedJobId];

      const terminalState = event.result.aborted || event.result.notice ? 'error' : 'done';
      options.onProgress(formatAtomProgress(atom, terminalState));

      if (state.expectedStaleAborts.has(event.completedJobId)) {
        state.expectedStaleAborts.delete(event.completedJobId);
        return 'handled';
      }

      if (event.result.aborted || event.result.notice) {
        enterFailureDrain(state, executionSvc, {
          aborted: Boolean(event.result.aborted),
          message: `Step ${atom.stepIndex}, atom '${atom.agent}' failed: ${describeTerminalFailure(event.result)}`,
        });
        return 'handled';
      }

      state.results.set(atom.atomKey, event.result.content);
      options.onAtomTerminal?.(snapshotWaitState(state));
      return 'handled';
    }

    case 'running':
      return 'check-stale';
  }
}

async function awaitWaitCycle(
  state: AwaitStepState,
  executionSvc: WorkflowExecutionPort,
  ctx: CallerContext,
  options: WaitForAtomsOptions,
  buildPartialStepDetailsForCycle: () => StepDetail[],
): Promise<'stream-ended' | 'stale-recovered'> {
  const timeoutSeconds = waitTimeoutSeconds(options.staleTimeoutMs, options.pollIntervalMs);

  for await (const event of executionSvc.waitStream({
    jobIds: [...state.pending.keys()],
    timeoutSeconds,
    cursor: state.cursor,
  })) {
    const eventOutcome = handleWaitEvent(event, state, executionSvc, options);
    if (eventOutcome !== 'check-stale') continue;
    if (state.failureDrain !== null || options.staleTimeoutMs <= 0) continue;

    const recovered = await recoverStaleAtom(state, executionSvc, ctx, {
      signal: options.signal,
      staleTimeoutMs: options.staleTimeoutMs,
      workDir: options.workDir,
      onProgress: options.onProgress,
      buildPartialStepDetails: buildPartialStepDetailsForCycle,
    });
    if (!recovered) continue;

    options.onStaleSwap?.(snapshotWaitState(state));
    return 'stale-recovered';
  }

  return 'stream-ended';
}

async function awaitStepCompletion(
  atoms: LaunchedAtom[],
  state: AwaitStepState,
  executionSvc: WorkflowExecutionPort,
  ctx: CallerContext,
  options: WaitForAtomsOptions,
): Promise<void> {
  const completedStepDetails = options.completedStepDetails ?? [];
  const buildPartialStepDetailsForCycle = (): StepDetail[] =>
    buildPartialStepDetails(atoms, completedStepDetails, state.results);

  while (state.pending.size > 0) {
    if (options.signal?.aborted && state.failureDrain === null) {
      enterFailureDrain(state, executionSvc, {
        aborted: true,
        message: 'Pipeline aborted (launched atoms may continue)',
      });
    }

    const cycleOutcome = await awaitWaitCycle(state, executionSvc, ctx, options, buildPartialStepDetailsForCycle);

    if (state.failureDrain !== null && (state.pending.size === 0 || Date.now() >= state.failureDrain.drainDeadline)) {
      throw createWorkflowExecutionError(
        state.failureDrain.firstFailure.message,
        state.failureDrain.firstFailure.aborted,
        buildPartialStepDetailsForCycle(),
      );
    }

    if (cycleOutcome === 'stale-recovered') continue;
  }
}

export async function waitForAtoms(
  atoms: LaunchedAtom[],
  executionSvc: WorkflowExecutionPort,
  ctx: CallerContext,
  options: WaitForAtomsOptions,
): Promise<Map<string, string>> {
  const state = createAwaitStepState(atoms);
  await awaitStepCompletion(atoms, state, executionSvc, ctx, options);
  return state.results;
}

async function drainLaunchedAtoms(
  launchedAtoms: LaunchedAtom[],
  executionSvc: WorkflowExecutionPort,
  ctx: CallerContext,
  options: {
    signal?: AbortSignal;
    staleTimeoutMs: number;
    pollIntervalMs: number;
    workDir?: string;
    onProgress: (message: string) => void;
  },
): Promise<StepDetail[]> {
  if (launchedAtoms.length === 0) return [];

  executionSvc.abort(launchedAtoms.map((atom) => atom.jobId));

  try {
    const results = await waitForAtoms(launchedAtoms, executionSvc, ctx, {
      signal: options.signal,
      staleTimeoutMs: options.staleTimeoutMs,
      pollIntervalMs: options.pollIntervalMs,
      workDir: options.workDir,
      onProgress: options.onProgress,
      completedStepDetails: [],
    });
    return buildStepDetailsForAtoms(launchedAtoms, results);
  } catch (error) {
    if (error instanceof WorkflowExecutionError) {
      return error.stepDetails;
    }
    throw error;
  }
}

export function formatStepOutput(results: Array<{ tagName: string; output: string }>): string {
  if (results.length === 0) return '';
  if (results.length === 1) return results[0].output;
  return results.map((result) => `<${result.tagName}>\n${result.output}\n</${result.tagName}>`).join('\n\n');
}

function requireStepResult(stepIndex: number, atom: LaunchedAtom, results: Map<string, string>): string {
  const output = results.get(atom.atomKey);
  if (output !== undefined) return output;
  throw new Error(`Step ${stepIndex}, atom '${atom.agent}' completed without a result`);
}

/**
 * Dedup launched atoms into per-session handles. Multiple atoms can share a session
 * (resume paths, defensive workflows), so downstream cleanup should see each session once.
 */
export function toSessionHandles(
  launchedAtoms: readonly { providerName: string; sessionId: string }[],
): WorkflowSessionHandle[] {
  const seen = new Set<string>();
  const handles: WorkflowSessionHandle[] = [];

  for (const atom of launchedAtoms) {
    const key = `${atom.providerName}:${atom.sessionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    handles.push({ providerName: atom.providerName, sessionId: atom.sessionId });
  }

  return handles;
}

type StepLaunchResult = {
  launchedAtoms: LaunchedAtom[];
  launchError: unknown | null;
};

type FinalizedStep = {
  stepDetails: StepDetail[];
  stepPrompt: string;
};

async function launchStepAtoms(
  step: PipelineAST[number],
  stepIndex: number,
  stepPrompt: string,
  defaultProviderName: string,
  executionSvc: WorkflowExecutionPort,
  ctx: CallerContext,
  options: {
    context?: string;
    workDir?: string;
    signal?: AbortSignal;
    workflowJobId?: string;
    completedStepDetails: StepDetail[];
  },
): Promise<StepLaunchResult> {
  const launchedAtoms: LaunchedAtom[] = [];
  let launchError: unknown = null;

  await Promise.all(
    step.map(async (atom, atomIndex) => {
      try {
        const launched = await launchAtomWithRetry({
          atom,
          atomIndex,
          stepIndex,
          stepPrompt,
          context: options.context,
          workDir: options.workDir,
          defaultProviderName,
          executionSvc,
          ctx,
          signal: options.signal,
          completedStepDetails: options.completedStepDetails,
          workflowJobId: options.workflowJobId,
        });
        launchedAtoms.push(launched);
      } catch (error) {
        launchError ??= error;
      }
    }),
  );

  launchedAtoms.sort((left, right) => left.atomIndex - right.atomIndex);
  return { launchedAtoms, launchError };
}

async function handleStepLaunchFailure(
  launchError: unknown,
  launchedAtoms: LaunchedAtom[],
  executionSvc: WorkflowExecutionPort,
  ctx: CallerContext,
  options: {
    signal?: AbortSignal;
    staleTimeoutMs: number;
    pollIntervalMs: number;
    workDir?: string;
    onProgress: (message: string) => void;
    completedStepDetails: StepDetail[];
  },
): Promise<never> {
  const drainedStepDetails = await drainLaunchedAtoms(launchedAtoms, executionSvc, ctx, {
    signal: options.signal,
    staleTimeoutMs: options.staleTimeoutMs,
    pollIntervalMs: options.pollIntervalMs,
    workDir: options.workDir,
    onProgress: options.onProgress,
  });
  const baseStepDetails =
    launchError instanceof WorkflowExecutionError ? launchError.stepDetails : options.completedStepDetails;
  let message = 'Unknown error';
  if (launchError instanceof Error) {
    message = launchError.message;
  } else if (typeof launchError === 'string') {
    message = launchError;
  }
  const aborted = launchError instanceof WorkflowExecutionError ? launchError.aborted : false;
  throw createWorkflowExecutionError(message, aborted, [...baseStepDetails, ...drainedStepDetails]);
}

function checkpointStepLaunch(
  persistCheckpoint: PersistCheckpoint,
  stepIndex: number,
  stepPrompt: string,
  launchedAtoms: LaunchedAtom[],
): void {
  persistCheckpoint(stepIndex, stepPrompt, launchedAtoms, new Map(), { jobs: {} }, new Map(), new Map(), new Set());
}

function checkpointStepCompletion(
  persistCheckpoint: PersistCheckpoint,
  stepIndex: number,
  stepPrompt: string,
  launchedAtoms: LaunchedAtom[],
  completedOutputs: Map<string, string>,
): void {
  persistCheckpoint(
    stepIndex,
    stepPrompt,
    launchedAtoms,
    completedOutputs,
    { jobs: {} },
    new Map(),
    new Map(),
    new Set(),
  );
}

async function awaitLaunchedStepResults(
  launchedAtoms: LaunchedAtom[],
  stepIndex: number,
  stepPrompt: string,
  executionSvc: WorkflowExecutionPort,
  ctx: CallerContext,
  options: {
    signal?: AbortSignal;
    staleTimeoutMs: number;
    pollIntervalMs: number;
    workDir?: string;
    onProgress: (message: string) => void;
    completedStepDetails: StepDetail[];
    persistCheckpoint: PersistCheckpoint;
  },
): Promise<Map<string, string>> {
  try {
    const checkpointFromWaitState = (waitState: WaitInternalState): void => {
      options.persistCheckpoint(
        stepIndex,
        stepPrompt,
        launchedAtoms,
        waitState.completedOutputs,
        waitState.cursor,
        waitState.lastActivityAt,
        waitState.staleRetries,
        waitState.expectedStaleAborts,
        waitState.failureDrain,
      );
    };

    return await waitForAtoms(launchedAtoms, executionSvc, ctx, {
      signal: options.signal,
      staleTimeoutMs: options.staleTimeoutMs,
      pollIntervalMs: options.pollIntervalMs,
      workDir: options.workDir,
      onProgress: options.onProgress,
      completedStepDetails: options.completedStepDetails,
      onAtomTerminal: checkpointFromWaitState,
      onStaleSwap: checkpointFromWaitState,
    });
  } catch (error) {
    if (error instanceof WorkflowExecutionError) {
      throw error;
    }

    const message = errorMessage(error);
    throw createWorkflowExecutionError(message, Boolean(options.signal?.aborted), [...options.completedStepDetails]);
  }
}

function finalizeStep(
  stepIndex: number,
  launchedAtoms: LaunchedAtom[],
  stepResults: Map<string, string>,
): FinalizedStep {
  return {
    stepDetails: buildStepDetailsForAtoms(launchedAtoms, stepResults),
    stepPrompt: formatStepOutput(
      launchedAtoms.map((atom) => ({
        tagName: atom.tagName,
        output: requireStepResult(stepIndex, atom, stepResults),
      })),
    ),
  };
}

/**
 * Resume a workflow pipeline from a persisted checkpoint.
 * Reconstructs the active step's wait state and re-enters the wait loop,
 * then launches subsequent steps through the normal executePipeline loop.
 *
 * Separate from executePipeline to avoid parameterizing the fresh-launch
 * path with checkpoint state.
 */
export async function resumePipeline(
  checkpoint: WorkflowCheckpoint,
  ast: PipelineAST,
  defaultProviderName: string,
  executionSvc: WorkflowExecutionPort,
  ctx: CallerContext,
  options: {
    context?: string;
    workDir?: string;
    signal?: AbortSignal;
    onProgress?: (message: string) => void;
    staleTimeoutMs?: number;
    pollIntervalMs?: number;
    workflowJobId?: string;
    progressStore?: WorkflowCheckpointWriter;
  } = {},
): Promise<PipelineResult> {
  const onProgress = options.onProgress ?? (() => {});
  const staleTimeoutMs = options.staleTimeoutMs ?? DEFAULT_STALE_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_WAIT_POLL_INTERVAL_MS;
  const stepDetails: StepDetail[] = [...checkpoint.completedStepDetails];
  let stepPrompt = checkpoint.stepPrompt;
  const activeStepIndex = checkpoint.stepIndex;
  const allLaunchedAtoms: LaunchedAtom[] = [];

  const activeAtoms: LaunchedAtom[] = checkpoint.atoms
    .filter((a) => a.stepIndex === activeStepIndex)
    .map((atom) => ({ ...atom }));

  const alreadyCompleted = new Map(Object.entries(checkpoint.completedOutputs));
  const pendingAtoms = activeAtoms.filter((a) => !alreadyCompleted.has(a.atomKey));

  allLaunchedAtoms.push(...activeAtoms);

  const persistCheckpoint = createCheckpointPersister(
    options.workflowJobId,
    options.progressStore,
    defaultProviderName,
    checkpoint.sessionId,
    stepDetails,
  );

  try {
    if (pendingAtoms.length > 0) {
      onProgress(`resuming step ${activeStepIndex} (${pendingAtoms.length} pending atoms)`);

      const checkpointFromWaitState = (waitState: WaitInternalState): void => {
        persistCheckpoint(
          activeStepIndex,
          stepPrompt,
          activeAtoms,
          waitState.completedOutputs,
          waitState.cursor,
          waitState.lastActivityAt,
          waitState.staleRetries,
          waitState.expectedStaleAborts,
          waitState.failureDrain,
        );
      };

      const stepResults = await waitForAtoms(pendingAtoms, executionSvc, ctx, {
        signal: options.signal,
        staleTimeoutMs,
        pollIntervalMs,
        workDir: options.workDir,
        onProgress,
        completedStepDetails: stepDetails,
        onAtomTerminal: checkpointFromWaitState,
        onStaleSwap: checkpointFromWaitState,
      });

      for (const [key, value] of stepResults) {
        alreadyCompleted.set(key, value);
      }

      const orderedStepDetails = buildStepDetailsForAtoms(activeAtoms, alreadyCompleted);
      stepDetails.push(...orderedStepDetails);
      stepPrompt = formatStepOutput(
        activeAtoms.map((atom) => ({
          tagName: atom.tagName,
          output: alreadyCompleted.get(atom.atomKey) ?? '',
        })),
      );

      checkpointStepCompletion(persistCheckpoint, activeStepIndex, stepPrompt, activeAtoms, alreadyCompleted);
      onProgress(`step ${activeStepIndex} completed (resumed)`);
    } else if (activeAtoms.length > 0) {
      const orderedStepDetails = buildStepDetailsForAtoms(activeAtoms, alreadyCompleted);
      stepDetails.push(...orderedStepDetails);
      stepPrompt = formatStepOutput(
        activeAtoms.map((atom) => ({
          tagName: atom.tagName,
          output: alreadyCompleted.get(atom.atomKey) ?? '',
        })),
      );
      onProgress(`step ${activeStepIndex} already completed, skipping`);
    }

    for (let stepIndex = activeStepIndex + 1; stepIndex < ast.length; stepIndex += 1) {
      const step = ast[stepIndex];
      onProgress(`step ${stepIndex} started`);

      const { launchedAtoms, launchError } = await launchStepAtoms(
        step,
        stepIndex,
        stepPrompt,
        defaultProviderName,
        executionSvc,
        ctx,
        {
          context: options.context,
          workDir: options.workDir,
          signal: options.signal,
          workflowJobId: options.workflowJobId,
          completedStepDetails: stepDetails,
        },
      );
      allLaunchedAtoms.push(...launchedAtoms);

      checkpointStepLaunch(persistCheckpoint, stepIndex, stepPrompt, launchedAtoms);

      if (launchError !== null) {
        await handleStepLaunchFailure(launchError, launchedAtoms, executionSvc, ctx, {
          signal: options.signal,
          staleTimeoutMs,
          pollIntervalMs,
          workDir: options.workDir,
          onProgress,
          completedStepDetails: stepDetails,
        });
      }

      const stepResults = await awaitLaunchedStepResults(launchedAtoms, stepIndex, stepPrompt, executionSvc, ctx, {
        signal: options.signal,
        staleTimeoutMs,
        pollIntervalMs,
        workDir: options.workDir,
        onProgress,
        completedStepDetails: stepDetails,
        persistCheckpoint,
      });
      const completedStep = finalizeStep(stepIndex, launchedAtoms, stepResults);
      stepDetails.push(...completedStep.stepDetails);
      stepPrompt = completedStep.stepPrompt;

      checkpointStepCompletion(persistCheckpoint, stepIndex, stepPrompt, launchedAtoms, stepResults);
      onProgress(`step ${stepIndex} completed`);
    }

    return {
      finalOutput: stepPrompt,
      stepDetails,
    };
  } finally {
    executionSvc.cleanupWorkflowSessions(toSessionHandles(allLaunchedAtoms));
  }
}

export async function executePipeline(
  ast: PipelineAST,
  initialPrompt: string,
  defaultProviderName: string,
  executionSvc: WorkflowExecutionPort,
  ctx: CallerContext,
  options: {
    context?: string;
    workDir?: string;
    signal?: AbortSignal;
    onProgress?: (message: string) => void;
    staleTimeoutMs?: number;
    pollIntervalMs?: number;
    workflowJobId?: string;
    progressStore?: WorkflowCheckpointWriter;
  } = {},
): Promise<PipelineResult> {
  const onProgress = options.onProgress ?? (() => {});
  const staleTimeoutMs = options.staleTimeoutMs ?? DEFAULT_STALE_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_WAIT_POLL_INTERVAL_MS;
  const stepDetails: StepDetail[] = [];
  let stepPrompt = initialPrompt;
  const allLaunchedAtoms: LaunchedAtom[] = [];

  const persistCheckpoint = createCheckpointPersister(
    options.workflowJobId,
    options.progressStore,
    defaultProviderName,
    '',
    stepDetails,
  );

  persistCheckpoint(0, stepPrompt, [], new Map(), { jobs: {} }, new Map(), new Map(), new Set());

  try {
    for (let stepIndex = 0; stepIndex < ast.length; stepIndex += 1) {
      const step = ast[stepIndex];
      onProgress(`step ${stepIndex} started`);

      const { launchedAtoms, launchError } = await launchStepAtoms(
        step,
        stepIndex,
        stepPrompt,
        defaultProviderName,
        executionSvc,
        ctx,
        {
          context: options.context,
          workDir: options.workDir,
          signal: options.signal,
          completedStepDetails: stepDetails,
          workflowJobId: options.workflowJobId,
        },
      );
      allLaunchedAtoms.push(...launchedAtoms);

      checkpointStepLaunch(persistCheckpoint, stepIndex, stepPrompt, launchedAtoms);

      if (launchError !== null) {
        await handleStepLaunchFailure(launchError, launchedAtoms, executionSvc, ctx, {
          signal: options.signal,
          staleTimeoutMs,
          pollIntervalMs,
          workDir: options.workDir,
          onProgress,
          completedStepDetails: stepDetails,
        });
      }

      const stepResults = await awaitLaunchedStepResults(launchedAtoms, stepIndex, stepPrompt, executionSvc, ctx, {
        signal: options.signal,
        staleTimeoutMs,
        pollIntervalMs,
        workDir: options.workDir,
        onProgress,
        completedStepDetails: stepDetails,
        persistCheckpoint,
      });
      const completedStep = finalizeStep(stepIndex, launchedAtoms, stepResults);
      stepDetails.push(...completedStep.stepDetails);
      stepPrompt = completedStep.stepPrompt;

      checkpointStepCompletion(persistCheckpoint, stepIndex, stepPrompt, launchedAtoms, stepResults);
      onProgress(`step ${stepIndex} completed`);
    }

    return {
      finalOutput: stepPrompt,
      stepDetails,
    };
  } finally {
    executionSvc.cleanupWorkflowSessions(toSessionHandles(allLaunchedAtoms));
  }
}
