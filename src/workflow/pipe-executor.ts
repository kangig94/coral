import type { CallerContext, ExecutionService } from '../execution/service.js';
import type { LaunchDecision, TerminalResult, WaitCursor } from '../types.js';
import type { EffortLevel } from '../shared/schemas.js';
import type { PipeAtom, PipelineAST } from './types.js';

export const BUSY_PREFIX = 'Runner is busy (';
export const MAX_LAUNCH_ATTEMPTS = 3;
export const BOOTSTRAP_POLL_INTERVAL_MS = 50;
export const BOOTSTRAP_TIMEOUT_MS = 2_000;
export const SIBLING_DRAIN_TIMEOUT_MS = 15_000;

const DEFAULT_WAIT_POLL_INTERVAL_MS = 500;
const DEFAULT_BACKOFF_BASE_MS = 100;
const MAX_STALE_RECOVERY_RETRIES = 2;
const STALE_RESUME_PROMPT = 'Your previous execution timed out due to inactivity. Continue where you left off.';

type WorkflowAtoms = Record<string, { effort?: EffortLevel; instruction?: string }>;

type LaunchContext = {
  atom: PipeAtom;
  atomIndex: number;
  stepIndex: number;
  stepPrompt: string;
  defaultProviderName: string;
  executionSvc: WorkflowExecutionService;
  ctx: CallerContext;
  atoms?: WorkflowAtoms;
  signal?: AbortSignal;
  onProgress: (message: string) => void;
};

export type WorkflowExecutionService = Pick<
  ExecutionService,
  'coralDispatch' | 'resume' | 'abort' | 'awaitLaunch' | 'waitStream'
>;

export type LaunchedAtom = {
  jobId: string;
  sessionId: string;
  providerName: string;
  coralOp: string;
  agent: string;
  tagName: string;
  stepIndex: number;
};

function normalizeErrorText(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : 'unknown error';
}

function stripErrorPrefix(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('Error:')) return trimmed.slice('Error:'.length).trimStart();
  return trimmed;
}

function isBusyMessage(text: string): boolean {
  return stripErrorPrefix(text).startsWith(BUSY_PREFIX);
}

function computeBackoffMs(attempt: number): number {
  return DEFAULT_BACKOFF_BASE_MS * (2 ** (attempt - 1));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function readAtomConfig(
  stepIndex: number,
  atomName: string,
  rawConfig: unknown,
): { effort?: EffortLevel; instruction?: string } {
  if (rawConfig == null) return {};
  if (typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
    throw new Error(`Step ${stepIndex + 1}, atom '${atomName}' atoms config must be an object`);
  }
  return rawConfig as { effort?: EffortLevel; instruction?: string };
}

function atomTagName(atom: PipeAtom): string {
  return atom.kind === 'prompt' ? 'step-result' : atom.agent;
}

function atomDiagnosticLabel(atom: PipeAtom, atomIndex: number): string {
  if (atom.kind === 'agent') return atom.agent;
  const truncated = atom.text.length > 20 ? `${atom.text.slice(0, 20)}...` : atom.text;
  return `prompt#${atomIndex + 1}(${truncated})`;
}

function failureForAtom(atom: LaunchedAtom, message: string): Error {
  return new Error(`Step ${atom.stepIndex + 1}, atom '${atom.agent}' failed: ${message}`);
}

function resumeFailureForAtom(atom: LaunchedAtom, message: string): Error {
  return new Error(`Step ${atom.stepIndex + 1}, atom '${atom.agent}' resume failed: ${message}`);
}

function describeLaunchRejection(
  stepIndex: number,
  atomName: string,
  decision: Exclude<LaunchDecision, { status: 'running' }>,
): Error {
  return new Error(`Step ${stepIndex + 1}, atom '${atomName}' launch failed: ${decision.message}`);
}

function describeTerminalFailure(result: TerminalResult): string {
  if (result.notice) return normalizeErrorText(result.notice);
  if (result.aborted) return 'aborted';
  return normalizeErrorText(result.content);
}

function waitTimeoutSeconds(staleTimeoutMs: number, pollIntervalMs: number): number {
  const timeoutMs = staleTimeoutMs > 0 ? Math.min(staleTimeoutMs, pollIntervalMs) : pollIntervalMs;
  return Math.max(1, Math.ceil(timeoutMs / 1000));
}

async function readLaunchFailureMessage(
  jobId: string,
  executionSvc: WorkflowExecutionService,
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
    defaultProviderName,
    executionSvc,
    ctx,
    atoms,
    signal,
    onProgress,
  } = context;
  const label = atomDiagnosticLabel(atom, atomIndex);
  const tagName = atomTagName(atom);
  const providerName = atom.provider ?? defaultProviderName;

  let coralName: string;
  let atomPrompt: string;
  let effort: EffortLevel | undefined;

  if (atom.kind === 'agent') {
    const namespace = atom.namespace ?? 'coral';
    if (namespace !== 'coral') {
      throw new Error(`Step ${stepIndex + 1}, atom '${label}' launch failed: unsupported namespace "${namespace}"`);
    }

    const config = readAtomConfig(stepIndex, atom.agent, atoms?.[atom.agent]);
    coralName = atom.agent;
    atomPrompt = config.instruction ? `${stepPrompt}\n\n${config.instruction}` : stepPrompt;
    effort = config.effort;
  } else {
    coralName = 'workflow-literal';
    // First-step prompt literals use only the literal text. Later prompt literals
    // prepend the literal before the previous step output so instruction comes first.
    atomPrompt = stepIndex === 0 || stepPrompt.length === 0
      ? atom.text
      : `${atom.text}\n\n${stepPrompt}`;
  }

  for (let attempt = 1; attempt <= MAX_LAUNCH_ATTEMPTS; attempt += 1) {
    if (signal?.aborted) throw new Error('Pipeline aborted (launched atoms may continue)');

    const decision = await executionSvc.coralDispatch(
      providerName,
      coralName,
      {
        prompt: atomPrompt,
        cwd: ctx.projectRoot,
      },
      ctx,
    );

    if (decision.status === 'rejected') {
      throw describeLaunchRejection(stepIndex, label, decision);
    }

    const launchState = await executionSvc.awaitLaunch(decision.job, BOOTSTRAP_TIMEOUT_MS);
    if (launchState === 'busy') {
      if (attempt === MAX_LAUNCH_ATTEMPTS) break;
      onProgress(`step ${stepIndex + 1} atom ${label} busy (attempt ${attempt}), retrying`);
      await sleep(computeBackoffMs(attempt), signal);
      continue;
    }
    if (launchState === 'error') {
      const message = await readLaunchFailureMessage(decision.job, executionSvc, signal);
      throw new Error(`Step ${stepIndex + 1}, atom '${label}' failed: ${message ?? 'unknown error'}`);
    }

    return {
      jobId: decision.job,
      sessionId: decision.session,
      providerName,
      coralOp: `coral:${coralName}`,
      agent: label,
      tagName,
      stepIndex,
    };
  }

  throw new Error(
    `Step ${stepIndex + 1}, atom '${label}' failed: capacity busy after ${MAX_LAUNCH_ATTEMPTS} attempts`,
  );
}

async function recoverStaleAtom(
  pending: Map<string, LaunchedAtom>,
  staleRetries: Map<string, number>,
  expectedStaleAborts: Set<string>,
  lastActivityAt: Map<string, number>,
  cursor: WaitCursor,
  executionSvc: WorkflowExecutionService,
  ctx: CallerContext,
  options: {
    signal?: AbortSignal;
    staleTimeoutMs: number;
    onProgress: (message: string) => void;
  },
): Promise<boolean> {
  const now = Date.now();

  for (const atom of pending.values()) {
    const lastActive = lastActivityAt.get(atom.agent) ?? now;
    if (now - lastActive < options.staleTimeoutMs) continue;

    const retries = staleRetries.get(atom.agent) ?? 0;
    if (retries >= MAX_STALE_RECOVERY_RETRIES) {
      throw new Error(
        `Step ${atom.stepIndex + 1}, atom '${atom.agent}' stale after ${retries} recovery attempts`,
      );
    }

    expectedStaleAborts.add(atom.jobId);
    options.onProgress(`atom ${atom.agent} stale, aborting`);
    executionSvc.abort([atom.jobId]);

    if (options.signal?.aborted) {
      throw new Error('Pipeline aborted (launched atoms may continue)');
    }

    const resumed = await executionSvc.resume(
      atom.providerName,
      {
        sessionId: atom.sessionId,
        prompt: STALE_RESUME_PROMPT,
        cwd: ctx.projectRoot,
      },
      ctx,
    );

    if (resumed.status === 'rejected') {
      throw resumeFailureForAtom(atom, resumed.message);
    }

    const launchState = await executionSvc.awaitLaunch(resumed.job, BOOTSTRAP_TIMEOUT_MS);
    if (launchState === 'busy') {
      throw resumeFailureForAtom(atom, 'capacity busy');
    }
    if (launchState === 'error') {
      const message = await readLaunchFailureMessage(resumed.job, executionSvc, options.signal);
      throw resumeFailureForAtom(atom, message ?? 'unknown error');
    }

    pending.delete(atom.jobId);
    delete cursor.jobs[atom.jobId];
    pending.set(resumed.job, {
      ...atom,
      jobId: resumed.job,
      sessionId: resumed.session,
    });
    staleRetries.set(atom.agent, retries + 1);

    const resumedAt = Date.now();
    for (const sibling of pending.values()) {
      lastActivityAt.set(sibling.agent, resumedAt);
    }

    options.onProgress(`atom ${atom.agent} resumed`);
    return true;
  }

  return false;
}

export async function waitForAtoms(
  atoms: LaunchedAtom[],
  executionSvc: WorkflowExecutionService,
  ctx: CallerContext,
  options: {
    signal?: AbortSignal;
    staleTimeoutMs: number;
    pollIntervalMs: number;
    onProgress: (message: string) => void;
  },
): Promise<Map<string, string>> {
  const pending = new Map<string, LaunchedAtom>();
  const results = new Map<string, string>();
  const lastActivityAt = new Map<string, number>();
  const staleRetries = new Map<string, number>();
  const expectedStaleAborts = new Set<string>();
  const cursor: WaitCursor = { jobs: {} };
  const startedAt = Date.now();

  for (const atom of atoms) {
    pending.set(atom.jobId, atom);
    lastActivityAt.set(atom.agent, startedAt);
    staleRetries.set(atom.agent, 0);
  }

  let firstFailure: Error | null = null;
  let abortRequested = false;
  let drainDeadline = 0;

  while (pending.size > 0) {
    if (options.signal?.aborted) {
      throw new Error('Pipeline aborted (launched atoms may continue)');
    }

    let recoveredThisCycle = false;
    const timeoutSeconds = waitTimeoutSeconds(options.staleTimeoutMs, options.pollIntervalMs);

    for await (const event of executionSvc.waitStream({
      jobIds: [...pending.keys()],
      timeoutSeconds,
      cursor,
    })) {
      if (event.type === 'progress') {
        cursor.jobs[event.jobId] = event.eventId;
        const atom = pending.get(event.jobId);
        if (!atom) continue;
        lastActivityAt.set(atom.agent, Date.now());
        options.onProgress(`atom ${atom.agent}: ${event.message}`);
        continue;
      }

      if (event.type === 'terminal') {
        const atom = pending.get(event.completedJobId);
        if (!atom) continue;

        pending.delete(event.completedJobId);
        delete cursor.jobs[event.completedJobId];

        const terminalState = event.result.aborted || event.result.notice ? 'error' : 'completed';
        options.onProgress(`step ${atom.stepIndex + 1} atom ${atom.agent} ${terminalState}`);

        if (expectedStaleAborts.has(event.completedJobId)) {
          expectedStaleAborts.delete(event.completedJobId);
          continue;
        }

        if (event.result.aborted || event.result.notice) {
          firstFailure ??= failureForAtom(atom, describeTerminalFailure(event.result));
          continue;
        }

        results.set(atom.agent, event.result.content);
        continue;
      }

      if (options.staleTimeoutMs <= 0) continue;

      recoveredThisCycle = await recoverStaleAtom(
        pending,
        staleRetries,
        expectedStaleAborts,
        lastActivityAt,
        cursor,
        executionSvc,
        ctx,
        {
          signal: options.signal,
          staleTimeoutMs: options.staleTimeoutMs,
          onProgress: options.onProgress,
        },
      );

      if (recoveredThisCycle) break;
    }

    if (firstFailure !== null && !abortRequested) {
      abortRequested = true;
      drainDeadline = Date.now() + SIBLING_DRAIN_TIMEOUT_MS;
      executionSvc.abort([...pending.keys()]);
    }

    if (firstFailure !== null && (pending.size === 0 || Date.now() >= drainDeadline)) {
      throw firstFailure;
    }

    if (recoveredThisCycle) continue;
  }

  return results;
}

export function formatStepOutput(results: Array<{ tagName: string; output: string }>): string {
  if (results.length === 0) return '';
  if (results.length === 1) return results[0].output;
  return results.map((result) => `<${result.tagName}>\n${result.output}\n</${result.tagName}>`).join('\n\n');
}

function requireStepResult(stepIndex: number, atom: LaunchedAtom, results: Map<string, string>): string {
  const output = results.get(atom.agent);
  if (output !== undefined) return output;
  throw new Error(`Step ${stepIndex + 1}, atom '${atom.agent}' completed without a result`);
}

export async function executePipeline(
  ast: PipelineAST,
  initialPrompt: string,
  defaultProviderName: string,
  executionSvc: WorkflowExecutionService,
  ctx: CallerContext,
  options: {
    atoms?: WorkflowAtoms;
    signal?: AbortSignal;
    onProgress?: (message: string) => void;
    staleTimeoutMs?: number;
    pollIntervalMs?: number;
  } = {},
): Promise<string> {
  const onProgress = options.onProgress ?? (() => {});
  const staleTimeoutMs = options.staleTimeoutMs ?? 0;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_WAIT_POLL_INTERVAL_MS;
  let stepPrompt = initialPrompt;

  for (let stepIndex = 0; stepIndex < ast.length; stepIndex += 1) {
    const step = ast[stepIndex];
    onProgress(`step ${stepIndex + 1} started`);

    const launchedAtoms = await Promise.all(
      step.map((atom, atomIndex) => launchAtomWithRetry({
        atom,
        atomIndex,
        stepIndex,
        stepPrompt,
        defaultProviderName,
        executionSvc,
        ctx,
        atoms: options.atoms,
        signal: options.signal,
        onProgress,
      })),
    );

    const stepResults = await waitForAtoms(launchedAtoms, executionSvc, ctx, {
      signal: options.signal,
      staleTimeoutMs,
      pollIntervalMs,
      onProgress,
    });

    stepPrompt = formatStepOutput(launchedAtoms.map((atom) => ({
      tagName: atom.tagName,
      output: requireStepResult(stepIndex, atom, stepResults),
    })));
    onProgress(`step ${stepIndex + 1} completed`);
  }

  return stepPrompt;
}
