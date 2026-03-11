import { homedir } from 'node:os';
import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { CallerContext, ExecutionService } from '../execution/service.js';
import type { TerminalResult, WaitCursor } from '../types.js';
import type { PipeAtom, PipelineAST } from './types.js';

export const BOOTSTRAP_TIMEOUT_MS = 2_000;
export const SIBLING_DRAIN_TIMEOUT_MS = 15_000;

const DEFAULT_WAIT_POLL_INTERVAL_MS = 500;
const MAX_STALE_RECOVERY_RETRIES = 2;
const STALE_RESUME_PROMPT = 'Your previous execution timed out due to inactivity. Continue where you left off.';

type WorkflowAtoms = Record<string, { instruction?: string }>;

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
  executionSvc: WorkflowExecutionService;
  ctx: CallerContext;
  atoms?: WorkflowAtoms;
  signal?: AbortSignal;
  completedStepDetails: StepDetail[];
};

export type WorkflowExecutionService = Pick<
  ExecutionService,
  'coralDispatch' | 'resume' | 'abort' | 'awaitLaunch' | 'waitStream' | 'getConversationRef'
>;

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

function cleanupClaudeSessions(sessionIds: string[]): void {
  if (sessionIds.length === 0) return;
  const targets = new Set(sessionIds.map((id) => `${id}.jsonl`));
  const projectsDir = join(homedir(), '.claude', 'projects');
  (async () => {
    const dirs = await readdir(projectsDir, { withFileTypes: true });
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const files = await readdir(join(projectsDir, dir.name)).catch(() => [] as string[]);
      for (const file of files) {
        if (targets.has(file)) await unlink(join(projectsDir, dir.name, file)).catch(() => {});
      }
    }
  })().catch(() => {});
}

function stripElapsedPrefix(message: string): string {
  if (!message.startsWith('[')) return message;
  const closeBracket = message.indexOf('] ');
  if (closeBracket < 0) return message;
  return message.slice(closeBracket + 2);
}

function readAtomConfig(
  stepIndex: number,
  atomName: string,
  rawConfig: unknown,
): { instruction?: string } {
  if (rawConfig == null) return {};
  if (typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
    throw new Error(`Step ${stepIndex}, atom '${atomName}' atoms config must be an object`);
  }
  return rawConfig as { instruction?: string };
}

function atomTagName(atom: PipeAtom): string {
  return atom.kind === 'prompt' ? 'step-result' : atom.agent;
}

function atomDiagnosticLabel(atom: PipeAtom, atomIndex: number): string {
  if (atom.kind === 'agent') return atom.agent;
  const truncated = atom.text.length > 20 ? `${atom.text.slice(0, 20)}...` : atom.text;
  return `prompt#${atomIndex}(${truncated})`;
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
    context: sharedContext,
    workDir,
    defaultProviderName,
    executionSvc,
    ctx,
    atoms,
    signal,
    completedStepDetails,
  } = context;
  const label = atomDiagnosticLabel(atom, atomIndex);
  const tagName = atomTagName(atom);
  const providerName = atom.provider ?? defaultProviderName;
  const atomKey = `${stepIndex}:${atomIndex}`;

  let coralName: string;
  let atomPrompt: string;
  let config: { instruction?: string } = {};

  if (atom.kind === 'agent') {
    const namespace = atom.namespace ?? 'coral';
    if (namespace !== 'coral') {
      throw new Error(`Step ${stepIndex}, atom '${label}' launch failed: unsupported namespace "${namespace}"`);
    }

    config = readAtomConfig(stepIndex, atom.agent, atoms?.[atom.agent]);
    coralName = atom.agent;
    atomPrompt = [sharedContext, stepPrompt, config.instruction].filter(Boolean).join('\n\n');
  } else {
    coralName = 'workflow-literal';
    // First-step prompt literals use the literal as the instruction body; shared
    // context still prepends when present. Later prompt literals prepend the
    // literal before the previous step output so instruction comes first.
    atomPrompt = stepIndex === 0
      ? (sharedContext ? `${sharedContext}\n\n${atom.text}` : atom.text)
      : [sharedContext, atom.text, stepPrompt].filter(Boolean).join('\n\n');
  }

  if (signal?.aborted) {
    throw createWorkflowExecutionError(
      'Pipeline aborted (launched atoms may continue)',
      true,
      completedStepDetails,
    );
  }

  const decision = await executionSvc.coralDispatch(
    providerName,
    coralName,
    {
      prompt: atomPrompt,
      cwd: workDir ?? ctx.projectRoot,
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
    workDir?: string;
    onProgress: (message: string) => void;
    buildPartialStepDetails: () => StepDetail[];
  },
): Promise<boolean> {
  const now = Date.now();

  for (const atom of pending.values()) {
    const lastActive = lastActivityAt.get(atom.atomKey) ?? now;
    if (now - lastActive < options.staleTimeoutMs) continue;

    const retries = staleRetries.get(atom.atomKey) ?? 0;
    if (retries >= MAX_STALE_RECOVERY_RETRIES) {
      throw createWorkflowExecutionError(
        `Step ${atom.stepIndex}, atom '${atom.agent}' stale after ${retries} recovery attempts`,
        false,
        options.buildPartialStepDetails(),
      );
    }

    expectedStaleAborts.add(atom.jobId);
    options.onProgress(`${atom.stepIndex}-${atom.agent.slice(0, 3)} stale, aborting`);
    executionSvc.abort([atom.jobId]);

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

    pending.delete(atom.jobId);
    delete cursor.jobs[atom.jobId];
    pending.set(resumed.job, {
      ...atom,
      jobId: resumed.job,
      sessionId: resumed.session,
    });
    staleRetries.set(atom.atomKey, retries + 1);

    const resumedAt = Date.now();
    for (const sibling of pending.values()) {
      lastActivityAt.set(sibling.atomKey, resumedAt);
    }

    options.onProgress(`${atom.stepIndex}-${atom.agent.slice(0, 3)} resumed`);
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
    workDir?: string;
    onProgress: (message: string) => void;
    completedStepDetails?: StepDetail[];
    claudeSessionIds?: string[];
  },
): Promise<Map<string, string>> {
  const pending = new Map<string, LaunchedAtom>();
  const results = new Map<string, string>();
  const lastActivityAt = new Map<string, number>();
  const staleRetries = new Map<string, number>();
  const expectedStaleAborts = new Set<string>();
  const cursor: WaitCursor = { jobs: {} };
  const startedAt = Date.now();
  const completedStepDetails = options.completedStepDetails ?? [];

  for (const atom of atoms) {
    pending.set(atom.jobId, atom);
    lastActivityAt.set(atom.atomKey, startedAt);
    staleRetries.set(atom.atomKey, 0);
  }

  let firstFailure: WaitFailure | null = null;
  let abortRequested = false;
  let drainDeadline = 0;

  const buildPartialStepDetails = (): StepDetail[] => [
    ...completedStepDetails,
    ...buildStepDetailsForAtoms(atoms, results),
  ];

  while (pending.size > 0) {
    if (options.signal?.aborted && firstFailure === null) {
      firstFailure = { aborted: true, message: 'Pipeline aborted (launched atoms may continue)' };
      abortRequested = true;
      drainDeadline = Date.now() + SIBLING_DRAIN_TIMEOUT_MS;
      executionSvc.abort([...pending.keys()]);
    }

    let recoveredThisCycle = false;
    const timeoutSeconds = waitTimeoutSeconds(options.staleTimeoutMs, options.pollIntervalMs);

    for await (const event of executionSvc.waitStream({
      jobIds: [...pending.keys()],
      timeoutSeconds,
      cursor,
    })) {
      if (event.type === 'queued') {
        const atom = pending.get(event.jobId);
        if (!atom) continue;
        lastActivityAt.set(atom.atomKey, Date.now());
        options.onProgress(`${atom.stepIndex}-${atom.agent.slice(0, 3)} queued (position ${event.queuePosition})`);
        continue;
      }

      if (event.type === 'progress') {
        cursor.jobs[event.jobId] = event.eventId;
        const atom = pending.get(event.jobId);
        if (!atom) continue;
        lastActivityAt.set(atom.atomKey, Date.now());
        options.onProgress(`${atom.stepIndex}-${atom.agent.slice(0, 3)} ${stripElapsedPrefix(event.message)}`);
        continue;
      }

      if (event.type === 'terminal') {
        const atom = pending.get(event.completedJobId);
        if (!atom) continue;

        pending.delete(event.completedJobId);
        delete cursor.jobs[event.completedJobId];

        const terminalState = event.result.aborted || event.result.notice ? 'error' : 'done';
        options.onProgress(`${atom.stepIndex}-${atom.agent.slice(0, 3)} ${terminalState}`);

        if (expectedStaleAborts.has(event.completedJobId)) {
          expectedStaleAborts.delete(event.completedJobId);
          continue;
        }

        if (event.result.aborted || event.result.notice) {
          firstFailure ??= {
            aborted: Boolean(event.result.aborted),
            message: `Step ${atom.stepIndex}, atom '${atom.agent}' failed: ${describeTerminalFailure(event.result)}`,
          };
          if (!abortRequested) {
            abortRequested = true;
            drainDeadline = Date.now() + SIBLING_DRAIN_TIMEOUT_MS;
            executionSvc.abort([...pending.keys()]);
          }
          continue;
        }

        results.set(atom.atomKey, event.result.content);
        if (atom.providerName === 'claude' && options.claudeSessionIds) {
          const ref = executionSvc.getConversationRef('claude', atom.sessionId);
          if (ref) options.claudeSessionIds.push(ref);
        }
        continue;
      }

      if (firstFailure !== null || options.staleTimeoutMs <= 0) continue;

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
          workDir: options.workDir,
          onProgress: options.onProgress,
          buildPartialStepDetails,
        },
      );

      if (recoveredThisCycle) break;
    }

    if (firstFailure !== null && (pending.size === 0 || Date.now() >= drainDeadline)) {
      throw createWorkflowExecutionError(firstFailure.message, firstFailure.aborted, buildPartialStepDetails());
    }

    if (recoveredThisCycle) continue;
  }

  return results;
}

async function drainLaunchedAtoms(
  launchedAtoms: LaunchedAtom[],
  executionSvc: WorkflowExecutionService,
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

export async function executePipeline(
  ast: PipelineAST,
  initialPrompt: string,
  defaultProviderName: string,
  executionSvc: WorkflowExecutionService,
  ctx: CallerContext,
  options: {
    atoms?: WorkflowAtoms;
    context?: string;
    workDir?: string;
    signal?: AbortSignal;
    onProgress?: (message: string) => void;
    staleTimeoutMs?: number;
    pollIntervalMs?: number;
  } = {},
): Promise<PipelineResult> {
  const onProgress = options.onProgress ?? (() => {});
  const staleTimeoutMs = options.staleTimeoutMs ?? 0;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_WAIT_POLL_INTERVAL_MS;
  const stepDetails: StepDetail[] = [];
  const claudeSessionIds: string[] = [];
  let stepPrompt = initialPrompt;

  for (let stepIndex = 0; stepIndex < ast.length; stepIndex += 1) {
    const step = ast[stepIndex];
    onProgress(`step ${stepIndex} started`);

    const launchedAtoms: LaunchedAtom[] = [];
    let launchError: unknown = null;

    await Promise.all(step.map(async (atom, atomIndex) => {
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
          atoms: options.atoms,
          signal: options.signal,
          completedStepDetails: stepDetails,
        });
        launchedAtoms.push(launched);
      } catch (error) {
        launchError ??= error;
      }
    }));

    launchedAtoms.sort((left, right) => left.atomIndex - right.atomIndex);

    if (launchError !== null) {
      const drainedStepDetails = await drainLaunchedAtoms(launchedAtoms, executionSvc, ctx, {
        signal: options.signal,
        staleTimeoutMs,
        pollIntervalMs,
        workDir: options.workDir,
        onProgress,
      });
      const baseStepDetails = launchError instanceof WorkflowExecutionError
        ? launchError.stepDetails
        : stepDetails;
      const message = launchError instanceof Error ? launchError.message : String(launchError);
      const aborted = launchError instanceof WorkflowExecutionError ? launchError.aborted : false;
      throw createWorkflowExecutionError(message, aborted, [...baseStepDetails, ...drainedStepDetails]);
    }

    try {
      const stepResults = await waitForAtoms(launchedAtoms, executionSvc, ctx, {
        signal: options.signal,
        staleTimeoutMs,
        pollIntervalMs,
        workDir: options.workDir,
        onProgress,
        completedStepDetails: stepDetails,
        claudeSessionIds,
      });

      const orderedStepDetails = buildStepDetailsForAtoms(launchedAtoms, stepResults);
      stepDetails.push(...orderedStepDetails);
      stepPrompt = formatStepOutput(launchedAtoms.map((atom) => ({
        tagName: atom.tagName,
        output: requireStepResult(stepIndex, atom, stepResults),
      })));
      onProgress(`step ${stepIndex} completed`);
    } catch (error) {
      if (error instanceof WorkflowExecutionError) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      throw createWorkflowExecutionError(message, Boolean(options.signal?.aborted), [...stepDetails]);
    }
  }

  // Fire-and-forget: clean up Claude session files after successful completion.
  // Done here (not per-atom) so stale recovery can still resume mid-pipeline.
  cleanupClaudeSessions(claudeSessionIds);

  return {
    finalOutput: stepPrompt,
    stepDetails,
  };
}
