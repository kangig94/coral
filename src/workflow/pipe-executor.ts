import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createProgressCursor,
  readProgressEvents,
  readSessionStatus,
  PROGRESS_FILE,
  type ProgressCursor,
} from '../runner/progress.js';
import type { SessionProvider } from '../runner/types.js';
import type { McpResult } from '../shared/mcp-utils.js';
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

type ParsedLaunchResult =
  | { kind: 'launched'; session: string; sessionDir: string }
  | { kind: 'busy' }
  | { kind: 'fatal'; error: Error };

type LaunchContext = {
  atom: PipeAtom;
  atomIndex: number;
  stepIndex: number;
  stepPrompt: string;
  defaultProvider: SessionProvider;
  dispatch: AtomDispatchFn;
  atoms?: WorkflowAtoms;
  projectRoot?: string;
  signal?: AbortSignal;
  onProgress: (message: string) => void;
};

export type LaunchedAtom = {
  session: string;
  sessionDir: string;
  agent: string;
  tagName: string;
  providerTool: SessionProvider;
  stepIndex: number;
  resumeOp: string;
};

type AtomAbortTarget = {
  session: string;
  agent: string;
};

type BootstrapStatus =
  | { kind: 'running' }
  | { kind: 'busy' }
  | { kind: 'error'; error: string };

export type AtomDispatchFn = (
  toolName: SessionProvider,
  args: Record<string, unknown>,
) => Promise<McpResult>;

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
  const normalized = stripErrorPrefix(text);
  return normalized.startsWith(BUSY_PREFIX);
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

function parseLaunchResult(result: McpResult, stepIndex: number, atomName: string): ParsedLaunchResult {
  const payloadText = result.content[0]?.text ?? '';
  if (result.isError) {
    if (isBusyMessage(payloadText)) return { kind: 'busy' };
    return {
      kind: 'fatal',
      error: new Error(`Step ${stepIndex + 1}, atom '${atomName}' launch failed: ${normalizeErrorText(payloadText)}`),
    };
  }

  try {
    const parsed = JSON.parse(payloadText) as { session?: unknown; session_dir?: unknown };
    if (typeof parsed.session !== 'string' || typeof parsed.session_dir !== 'string') {
      return {
        kind: 'fatal',
        error: new Error(
          `Step ${stepIndex + 1}, atom '${atomName}' launch failed: missing session/session_dir in response`,
        ),
      };
    }
    return { kind: 'launched', session: parsed.session, sessionDir: parsed.session_dir };
  } catch {
    return {
      kind: 'fatal',
      error: new Error(`Step ${stepIndex + 1}, atom '${atomName}' launch failed: malformed launch response JSON`),
    };
  }
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

function buildAtomPrompt(stepPrompt: string, instruction?: string): string {
  if (!instruction) return stepPrompt;
  return `${stepPrompt}\n\n${instruction}`;
}

function buildLiteralPrompt(stepIndex: number, atomText: string, stepPrompt: string): string {
  if (stepIndex === 0 || stepPrompt.length === 0) return atomText;
  return `${atomText}\n\n${stepPrompt}`;
}

function atomTagName(atom: PipeAtom): string {
  return atom.kind === 'prompt' ? 'step-result' : atom.agent;
}

function atomDiagnosticLabel(atom: PipeAtom, atomIndex: number): string {
  if (atom.kind === 'agent') return atom.agent;
  const truncated = atom.text.length > 20 ? `${atom.text.slice(0, 20)}...` : atom.text;
  return `prompt#${atomIndex + 1}(${truncated})`;
}

function readAtomOutput(stepIndex: number, atomName: string, sessionDir: string): string {
  try {
    return readFileSync(join(sessionDir, 'result.md'), 'utf-8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Step ${stepIndex + 1}, atom '${atomName}' failed to read result.md: ${detail}`);
  }
}

export async function readLaunchBootstrapStatus(
  sessionDir: string,
  signal?: AbortSignal,
  timeoutMs = BOOTSTRAP_TIMEOUT_MS,
): Promise<BootstrapStatus> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return { kind: 'error', error: 'aborted during bootstrap' };
    const status = readSessionStatus(sessionDir);
    if (status.status === 'error') {
      const message = status.error ?? 'unknown error';
      if (isBusyMessage(message)) return { kind: 'busy' };
      return { kind: 'error', error: message };
    }
    if (status.status === 'completed') return { kind: 'running' };
    await sleep(BOOTSTRAP_POLL_INTERVAL_MS, signal);
  }
  return { kind: 'running' };
}

async function retryBusyLaunchAttempt(
  attempt: number,
  stepIndex: number,
  atomLabel: string,
  onProgress: (message: string) => void,
  signal?: AbortSignal,
): Promise<boolean> {
  if (attempt === MAX_LAUNCH_ATTEMPTS) return false;
  onProgress(`step ${stepIndex + 1} atom ${atomLabel} busy (attempt ${attempt}), retrying`);
  await sleep(computeBackoffMs(attempt), signal);
  return true;
}

export async function launchAtomWithRetry(context: LaunchContext): Promise<LaunchedAtom> {
  const {
    atom,
    atomIndex,
    stepIndex,
    stepPrompt,
    defaultProvider,
    dispatch,
    atoms,
    projectRoot,
    signal,
    onProgress,
  } = context;
  const label = atomDiagnosticLabel(atom, atomIndex);
  const tagName = atomTagName(atom);
  const providerTool: SessionProvider = atom.provider ?? defaultProvider;
  let dispatchPayload: Record<string, unknown>;
  if (atom.kind === 'agent') {
    const namespace = atom.namespace ?? 'coral';
    if (namespace !== 'coral') {
      throw new Error(`Step ${stepIndex + 1}, atom '${label}' launch failed: unsupported namespace "${namespace}"`);
    }

    const config = readAtomConfig(stepIndex, atom.agent, atoms?.[atom.agent]);
    const atomPrompt = buildAtomPrompt(stepPrompt, config.instruction);

    dispatchPayload = {
      op: `coral:${atom.agent}`,
      prompt: atomPrompt,
      bypass: true,
      ...(projectRoot ? { working_directory: projectRoot } : {}),
      ...(config.effort ? { effort: config.effort } : {}),
    };
  } else {
    // First-step prompt literals use only the literal text — the initial pipeline prompt is intentionally
    // not forwarded, because the literal itself IS the complete instruction. Middle steps prepend the
    // literal before the previous step's output so the LLM reads instruction first, then context.
    const promptText = buildLiteralPrompt(stepIndex, atom.text, stepPrompt);
    dispatchPayload = {
      op: 'coral:workflow-literal',
      prompt: promptText,
      bypass: true,
      ...(projectRoot ? { working_directory: projectRoot } : {}),
    };
  }

  for (let attempt = 1; attempt <= MAX_LAUNCH_ATTEMPTS; attempt += 1) {
    if (signal?.aborted) throw new Error('Pipeline aborted (launched atoms may continue)');

    const launch = await dispatch(providerTool, dispatchPayload);
    const parsed = parseLaunchResult(launch, stepIndex, label);
    if (parsed.kind === 'busy') {
      if (await retryBusyLaunchAttempt(attempt, stepIndex, label, onProgress, signal)) continue;
      break;
    }
    if (parsed.kind === 'fatal') throw parsed.error;

    const bootstrap = await readLaunchBootstrapStatus(parsed.sessionDir, signal);
    if (bootstrap.kind === 'busy') {
      if (await retryBusyLaunchAttempt(attempt, stepIndex, label, onProgress, signal)) continue;
      break;
    }
    if (bootstrap.kind === 'error') {
      throw new Error(`Step ${stepIndex + 1}, atom '${label}' failed: ${normalizeErrorText(bootstrap.error)}`);
    }

    return {
      session: parsed.session,
      sessionDir: parsed.sessionDir,
      agent: label,
      tagName,
      providerTool,
      stepIndex,
      resumeOp: String(dispatchPayload.op),
    };
  }

  throw new Error(
    `Step ${stepIndex + 1}, atom '${label}' failed: capacity busy after ${MAX_LAUNCH_ATTEMPTS} attempts`,
  );
}

function emitProgressEvents(
  agent: string,
  sessionDir: string,
  cursor: ProgressCursor,
  onProgress: (message: string) => void,
  lastActivityTime: Map<string, number>,
): void {
  const events = readProgressEvents(join(sessionDir, PROGRESS_FILE), cursor);
  if (events.length > 0) {
    lastActivityTime.set(agent, Date.now());
  }
  for (const evt of events) {
    onProgress(`atom ${agent}: ${evt.message}`);
  }
}

function parseResumePayload(
  resumeText: string,
  stepIndex: number,
  atomName: string,
): { session: string; sessionDir: string } {
  let parsed: { session?: string; session_dir?: string };
  try {
    parsed = JSON.parse(resumeText) as { session?: string; session_dir?: string };
  } catch {
    throw new Error(`Step ${stepIndex + 1}, atom '${atomName}' resume returned malformed JSON`);
  }

  if (!parsed.session || !parsed.session_dir) {
    throw new Error(`Step ${stepIndex + 1}, atom '${atomName}' resume returned invalid response`);
  }

  return {
    session: parsed.session,
    sessionDir: parsed.session_dir,
  };
}

export async function waitForAllAtoms(
  atoms: LaunchedAtom[],
  signal: AbortSignal | undefined,
  onProgress: (message: string) => void,
  requestAbort: (target: AtomAbortTarget) => Promise<void>,
  options?: {
    staleTimeoutMs?: number;
    dispatch?: AtomDispatchFn;
    pollIntervalMs?: number;
    projectRoot?: string;
  },
): Promise<Map<string, { session: string; sessionDir: string }>> {
  const pending = new Set<string>();
  const sessionOverlay = new Map<string, { session: string; sessionDir: string }>();
  const cursors = new Map<string, ProgressCursor>();
  const lastActivityTime = new Map<string, number>();
  const staleRetryCount = new Map<string, number>();
  const expectedStaleAbortSessions = new Set<string>();
  const pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_WAIT_POLL_INTERVAL_MS;
  const staleTimeoutMs = options?.staleTimeoutMs ?? 0;

  const now = Date.now();
  for (const atom of atoms) {
    sessionOverlay.set(atom.agent, { session: atom.session, sessionDir: atom.sessionDir });
    pending.add(atom.session);
    cursors.set(atom.session, createProgressCursor());
    lastActivityTime.set(atom.agent, now);
    staleRetryCount.set(atom.agent, 0);
  }

  let firstFailure: Error | null = null;
  let abortRequested = false;
  let drainDeadline = 0;

  while (pending.size > 0) {
    if (signal?.aborted) {
      throw new Error('Pipeline aborted (launched atoms may continue)');
    }

    for (const atom of atoms) {
      const overlay = sessionOverlay.get(atom.agent)!;
      if (!pending.has(overlay.session)) continue;
      emitProgressEvents(atom.agent, overlay.sessionDir, cursors.get(overlay.session)!, onProgress, lastActivityTime);
    }

    for (const atom of atoms) {
      const overlay = sessionOverlay.get(atom.agent)!;
      if (!pending.has(overlay.session)) continue;

      const status = readSessionStatus(overlay.sessionDir);
      if (status.status !== 'completed' && status.status !== 'error') continue;

      emitProgressEvents(atom.agent, overlay.sessionDir, cursors.get(overlay.session)!, onProgress, lastActivityTime);

      pending.delete(overlay.session);
      cursors.delete(overlay.session);
      onProgress(`step ${atom.stepIndex + 1} atom ${atom.agent} ${status.status}`);
      lastActivityTime.set(atom.agent, Date.now());

      if (status.status !== 'error') continue;
      if (expectedStaleAbortSessions.has(overlay.session)) {
        expectedStaleAbortSessions.delete(overlay.session);
        continue;
      }
      if (firstFailure === null) {
        firstFailure = new Error(
          `Step ${atom.stepIndex + 1}, atom '${atom.agent}' failed: ${normalizeErrorText(status.error ?? 'unknown error')}`,
        );
      }
    }

    if (firstFailure !== null && !abortRequested) {
      abortRequested = true;
      drainDeadline = Date.now() + SIBLING_DRAIN_TIMEOUT_MS;
      for (const atom of atoms) {
        const overlay = sessionOverlay.get(atom.agent)!;
        if (!pending.has(overlay.session)) continue;
        void requestAbort({
          session: overlay.session,
          agent: atom.agent,
        }).catch(() => {});
      }
    }

    if (firstFailure !== null && (pending.size === 0 || Date.now() >= drainDeadline)) {
      throw firstFailure;
    }

    if (staleTimeoutMs > 0 && options?.dispatch) {
      let recoveredThisCycle = false;
      for (const atom of atoms) {
        const overlay = sessionOverlay.get(atom.agent)!;
        if (!pending.has(overlay.session)) continue;

        const lastActive = lastActivityTime.get(atom.agent) ?? Date.now();
        if (Date.now() - lastActive < staleTimeoutMs) continue;

        const retries = staleRetryCount.get(atom.agent) ?? 0;
        if (retries >= MAX_STALE_RECOVERY_RETRIES) {
          throw new Error(
            `Step ${atom.stepIndex + 1}, atom '${atom.agent}' stale after ${retries} recovery attempts`,
          );
        }

        const staleSession = overlay.session;
        const stepAtomPrefix = `Step ${atom.stepIndex + 1}, atom '${atom.agent}'`;
        const failResume = (detail: string): never => {
          expectedStaleAbortSessions.delete(staleSession);
          throw new Error(`${stepAtomPrefix} ${detail}`);
        };

        expectedStaleAbortSessions.add(staleSession);
        onProgress(`atom ${atom.agent} stale (no activity for ${Math.floor(staleTimeoutMs / 1000)}s), aborting`);
        await requestAbort({
          session: staleSession,
          agent: atom.agent,
        });

        if (signal?.aborted) {
          expectedStaleAbortSessions.delete(staleSession);
          break;
        }

        onProgress(`atom ${atom.agent} resuming (attempt ${retries + 1})`);
        const resumeResult = await options.dispatch(atom.providerTool, {
          op: atom.resumeOp,
          session: staleSession,
          prompt: STALE_RESUME_PROMPT,
          ...(options.projectRoot ? { working_directory: options.projectRoot } : {}),
        });

        if (resumeResult.isError) {
          failResume('resume failed: non-resumable session');
        }

        const resumeText = resumeResult.content?.[0]?.text;
        if (typeof resumeText !== 'string' || resumeText.length === 0) {
          failResume('resume returned empty response');
        }

        let resumedSession: { session: string; sessionDir: string };
        try {
          resumedSession = parseResumePayload(resumeText, atom.stepIndex, atom.agent);
        } catch (error) {
          expectedStaleAbortSessions.delete(staleSession);
          throw error;
        }

        pending.delete(staleSession);
        cursors.delete(staleSession);
        expectedStaleAbortSessions.delete(staleSession);

        sessionOverlay.set(atom.agent, resumedSession);
        pending.add(resumedSession.session);
        cursors.set(resumedSession.session, createProgressCursor());
        lastActivityTime.set(atom.agent, Date.now());
        staleRetryCount.set(atom.agent, retries + 1);

        // Reset activity time for all still-pending siblings to prevent
        // recovery latency from falsely triggering their stale detection.
        for (const sibling of atoms) {
          if (sibling.agent === atom.agent) continue;
          const siblingOverlay = sessionOverlay.get(sibling.agent)!;
          if (pending.has(siblingOverlay.session)) {
            lastActivityTime.set(sibling.agent, Date.now());
          }
        }

        recoveredThisCycle = true;
        break;
      }
      if (recoveredThisCycle) continue;
    }

    if (pending.size > 0) {
      await sleep(pollIntervalMs, signal);
    }
  }

  return sessionOverlay;
}

export function formatStepOutput(results: Array<{ tagName: string; output: string }>): string {
  if (results.length === 0) return '';
  if (results.length === 1) return results[0].output;
  return results.map((result) => `<${result.tagName}>\n${result.output}\n</${result.tagName}>`).join('\n\n');
}

export async function executePipeline(
  ast: PipelineAST,
  initialPrompt: string,
  defaultProvider: SessionProvider,
  dispatch: AtomDispatchFn,
  options: {
    atoms?: WorkflowAtoms;
    projectRoot?: string;
    signal?: AbortSignal;
    onProgress?: (message: string) => void;
    staleTimeoutMs?: number;
    pollIntervalMs?: number;
    abortSession?: (sessionId: string) => void;
  } = {},
): Promise<string> {
  const onProgress = options.onProgress ?? (() => {});
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
        defaultProvider,
        dispatch,
        atoms: options.atoms,
        projectRoot: options.projectRoot,
        signal: options.signal,
        onProgress,
      })),
    );

    const finalOverlay = await waitForAllAtoms(
      launchedAtoms,
      options.signal,
      onProgress,
      async ({ session, agent }) => {
        if (options.abortSession) {
          options.abortSession(session);
        } else {
          onProgress(`atom ${agent} abort skipped: no abortSession handler`);
        }
      },
      {
        staleTimeoutMs: options.staleTimeoutMs,
        dispatch,
        pollIntervalMs: options.pollIntervalMs,
        projectRoot: options.projectRoot,
      },
    );

    const stepOutputs = launchedAtoms.map((atom) => ({
      tagName: atom.tagName,
      output: readAtomOutput(stepIndex, atom.agent, finalOverlay.get(atom.agent)?.sessionDir ?? atom.sessionDir),
    }));
    stepPrompt = formatStepOutput(stepOutputs);
    onProgress(`step ${stepIndex + 1} completed`);
  }

  return stepPrompt;
}
