import { observeProcessLiveness, type ProcessLiveness } from '../infra/node-process.js';
import {
  KB_DAEMON_EVENT_MESSAGE,
  KB_DAEMON_PARENT_REQUEST_MESSAGE,
  KB_DAEMON_READY_MESSAGE,
  KB_DAEMON_RESPONSE_MESSAGE,
  encodeKbDaemonMessage,
  isKbDaemonAbortResult,
  isKbDaemonExpansionRequest,
  isKbDaemonJobsResult,
  isKbDaemonKbMutationRequest,
  isKbDaemonKbReadRequest,
  isKbDaemonParentResponseMessage,
  isKbDaemonRequestMessage,
  type KbDaemonCurateAssistantCompleteRequest,
  type KbDaemonExpansionRequest,
  type KbDaemonExpansionResult,
  type KbDaemonHealthResult,
  type KbDaemonControlMessage,
  type KbDaemonErrorEnvelope,
  type KbDaemonRequestMessage,
  type KbDaemonParentResponseMessage,
} from './protocol.js';
import { createKbDaemonRequestService } from './request-service.js';
import { createKbDaemonWriteRuntimeHost } from './runtime-host.js';
import { writeAuthorizationDecisionAudit } from '../infra/audit-log.js';
import { errorMessage } from '../infra/error-format.js';
import { rehydrateCoralSetupError, serializeCoralSetupError } from '../runtime/errors.js';
import { AbortError } from '../runtime/abort.js';
import type { CurateAssistantPort } from '../kb/curate/assistant.js';
import type { CurateUsageBudgetPort } from '../kb/curate/usage-budget.js';
import { parsePrincipalWire, principalToWire } from '../security/principal-wire.js';
import { authorizeCapability, authorizeResourceBinding } from '../security/policy/authorize.js';
import type { ResourceBinding } from '../security/principal.js';
import { canonicalizeWorkDir, type CanonicalWorkDir, WorkDirectoryError } from '../runtime/canonical-work-dir.js';

const DEFAULT_PARENT_WATCHDOG_INTERVAL_MS = 1_000;

/**
 * How long cooperative disposal is given before its signal is aborted, and how long the whole teardown is
 * given before this process exits regardless.
 *
 * Set here rather than derived from the shared signal-escalation constants. Those measure grace around a
 * signal sent to some other process — and `SIGKILL_GRACE_MS` in particular is time to confirm a disappearance
 * *after* SIGKILL, not grace before one. Borrowing them would assert an alignment with the supervisor's own
 * stop timeout that nothing keeps true, since that timeout is a separately hard-coded value. The durations
 * happen to coincide today; that is arithmetic, not a shared schedule.
 */
const DEFAULT_DISPOSE_ABORT_MS = 5_000;
const DEFAULT_TERMINAL_EXIT_MS = 10_000;

type IntervalHandle = ReturnType<typeof setInterval>;
type TimeoutHandle = ReturnType<typeof setTimeout>;

type PendingParentRequest = {
  resolve: (response: KbDaemonParentResponseMessage) => void;
  reject: (error: Error) => void;
};

export type KbDaemonMainOptions = {
  pluginRoot?: string;
  parentPid?: number | null;
};

type KbDaemonExpansionRpcPort = {
  expansionRpc(request: KbDaemonExpansionRequest): Promise<KbDaemonExpansionResult>;
};

function requestedBindingFromExpansionRequest(projectRoot: CanonicalWorkDir | undefined): ResourceBinding {
  return projectRoot === undefined ? { kind: 'unbound' } : { kind: 'project', root: projectRoot };
}

function writeControlMessage(message: KbDaemonControlMessage): void {
  process.stdout.write(encodeKbDaemonMessage(message));
}

function kbDaemonErrorEnvelope(error: unknown): KbDaemonErrorEnvelope {
  const setupError = serializeCoralSetupError(error);
  return {
    message: errorMessage(error),
    ...(setupError === null ? {} : { setupError }),
  };
}

function throwParentResponseError(error: KbDaemonErrorEnvelope): never {
  throw rehydrateCoralSetupError(error.setupError) ?? new Error(error.message);
}

export function resolveKbDaemonParentPid(value: string | undefined, selfPid = process.pid): number | null {
  const trimmed = value?.trim();
  if (trimmed === undefined || !/^\d+$/.test(trimmed)) {
    return null;
  }
  const pid = Number(trimmed);
  if (!Number.isInteger(pid) || pid <= 0 || pid === selfPid) {
    return null;
  }
  return pid;
}

export async function handleKbDaemonExpansionRpcRequest(
  params: unknown,
  kbWriteHost: KbDaemonExpansionRpcPort,
): Promise<KbDaemonExpansionResult> {
  if (!isKbDaemonExpansionRequest(params)) {
    return {
      ok: false,
      code: 'invalid_request',
      message: 'Malformed KB daemon expansion request.',
    };
  }

  let principal = parsePrincipalWire(params.ctx.principal, {
    transport: 'kb-daemon',
    credential: { kind: 'daemon-rpc', id: 'expansion-request' },
  });
  if (principal === null) {
    return {
      ok: false,
      code: 'invalid_request',
      message: 'Malformed KB daemon expansion principal.',
    };
  }

  const capabilityDecision = authorizeCapability(principal, 'expansion:manage');
  if (!capabilityDecision.ok) {
    const unbound = { kind: 'unbound' } as const;
    writeAuthorizationDecisionAudit(principal, `kb-daemon.expansion.${params.method}`, capabilityDecision, unbound);
    return {
      ok: false,
      code: 'unauthorized',
      message: 'KB daemon expansion request requires expansion:manage.',
      detail: capabilityDecision,
    };
  }

  let projectRoot: CanonicalWorkDir | undefined;
  try {
    projectRoot =
      params.ctx.projectRoot === undefined ? undefined : canonicalizeWorkDir(params.ctx.projectRoot, process.cwd());
  } catch (error: unknown) {
    if (!(error instanceof WorkDirectoryError)) throw error;
    return { ok: false, code: error.code, message: error.message };
  }
  const requestedBinding = requestedBindingFromExpansionRequest(projectRoot);
  if (principal.binding.kind === 'unbound' && requestedBinding.kind === 'project') {
    principal = { ...principal, binding: requestedBinding };
  }
  const decision = authorizeResourceBinding(principal, 'expansion:manage', requestedBinding);
  writeAuthorizationDecisionAudit(principal, `kb-daemon.expansion.${params.method}`, decision, requestedBinding);
  if (!decision.ok) {
    return {
      ok: false,
      code: 'unauthorized',
      message: 'KB daemon expansion request requires expansion:manage.',
      detail: decision,
    };
  }

  return kbWriteHost.expansionRpc({
    ...params,
    ctx: {
      ...params.ctx,
      ...(projectRoot === undefined ? {} : { projectRoot }),
      principal: principalToWire(principal),
    },
  });
}

export type KbDaemonParentWatchdogOptions = {
  parentPid: number | null | undefined;
  intervalMs?: number;
  observeLiveness?: (pid: number) => ProcessLiveness;
  getCurrentParentPid?: () => number;
  setIntervalFn?: (fn: () => void, ms: number) => IntervalHandle;
  clearIntervalFn?: (handle: IntervalHandle) => void;
  onParentExit: () => void;
};

export function startKbDaemonParentWatchdog(options: KbDaemonParentWatchdogOptions): IntervalHandle | null {
  const parentPid = options.parentPid;
  if (parentPid === null || parentPid === undefined || !Number.isInteger(parentPid) || parentPid <= 0) {
    return null;
  }
  const intervalMs =
    options.intervalMs !== undefined && Number.isFinite(options.intervalMs) && options.intervalMs > 0
      ? options.intervalMs
      : DEFAULT_PARENT_WATCHDOG_INTERVAL_MS;
  const observeLiveness = options.observeLiveness ?? observeProcessLiveness;
  const getCurrentParentPid = options.getCurrentParentPid ?? (() => process.ppid);
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;
  let handle: IntervalHandle | null = null;
  let stopped = false;
  const stopForParentExit = (): void => {
    if (stopped) {
      return;
    }
    stopped = true;
    if (handle !== null) {
      clearIntervalFn(handle);
    }
    handle = null;
    options.onParentExit();
  };
  handle = setIntervalFn(() => {
    if (getCurrentParentPid() !== parentPid) {
      stopForParentExit();
      return;
    }
    // Only an observed absence is a parent that exited. Unknown asks again on the next tick.
    if (observeLiveness(parentPid) === 'absent') stopForParentExit();
  }, intervalMs);
  (handle as { unref?: () => void }).unref?.();
  return handle;
}

/** One opened window. The deadline is already running; this is the part of it a caller can observe. */
export type KbDaemonTerminalWindow = Readonly<{
  /**
   * Aborted at the cooperative mark, so the joins that do observe a signal get their chance to unwind before
   * the process is taken out from under them.
   *
   * Not every join observes it. Disposal's `initPromise` join, a corpus mutation-lock wait already queued
   * behind another writer, and an expansion `stop()` already in flight each finish on their own schedule.
   * That is exactly why the exit is not made conditional on disposal having noticed.
   */
  signal: AbortSignal;
}>;

/** Seams for the window's two timers. Every field defaults to the real process-level behaviour. */
export type KbDaemonTerminalWindowOptions = {
  disposeAbortMs?: number;
  terminalExitMs?: number;
  setTimeoutFn?: (fn: () => void, ms: number) => TimeoutHandle;
  exit?: (code: number) => void;
  log?: (message: string) => void;
};

/** Holds a process's single window, so that opening it is something every stop trigger may attempt. */
export type KbDaemonTerminalWindowAuthority = Readonly<{
  /**
   * Opens the window, or returns the one already open. Idempotence is the contract, not an optimisation: a
   * teardown that is overrunning must not be able to buy itself more time by being asked to stop again, so
   * the deadline belongs to the first request and every later one inherits it.
   */
  open(exitCode: number): KbDaemonTerminalWindow;
}>;

/**
 * The authority over the window within which this process must cease to exist.
 *
 * A stop request used to be five triggers sharing one latch: whichever arrived first ran the cleanup, and the
 * other four became no-ops. Cleanup that never finished was therefore never escalated by anything — five
 * detectors, no enforcer. This window is the missing half. It is opened by the first trigger and is not itself
 * a trigger, so no later arrival can disarm it and none is needed to enforce it.
 *
 * The deadline is never cleared. A teardown that finishes cleanly usually reaches exit before the window
 * closes — though not always, since a daemon whose parent pipe is still open has nothing else that ends it,
 * and this timer is then what does.
 *
 * What this buys: an enforcement point that is reached on any stop where the event loop keeps making progress.
 * That covers the case that stranded a daemon in production, whose SIGTERM handler did run, found the stop
 * already latched, and returned.
 *
 * What it is not: a wall-clock bound. A timer fires when it becomes *eligible*, so a long synchronous stretch
 * inside disposal, or heavy timer starvation, delays the exit by however long that stretch lasts — and a loop
 * blocked indefinitely never reaches either timer at all. Nothing inside this process can close that; only an
 * enforcer outside it can.
 */
export function createKbDaemonTerminalWindowAuthority(
  options: KbDaemonTerminalWindowOptions = {},
): KbDaemonTerminalWindowAuthority {
  const disposeAbortMs = options.disposeAbortMs ?? DEFAULT_DISPOSE_ABORT_MS;
  const terminalExitMs = options.terminalExitMs ?? DEFAULT_TERMINAL_EXIT_MS;
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const log = options.log ?? ((message: string) => void process.stderr.write(message));
  let window: KbDaemonTerminalWindow | null = null;

  return Object.freeze({
    open: (exitCode: number): KbDaemonTerminalWindow => {
      if (window !== null) {
        return window;
      }
      const controller = new AbortController();
      const abortTimer = setTimeoutFn(() => {
        controller.abort(new Error(`KB daemon disposal exceeded its ${disposeAbortMs}ms cooperative window.`));
      }, disposeAbortMs);
      const exitTimer = setTimeoutFn(() => {
        log(`[kb-daemon] teardown did not complete within ${terminalExitMs}ms; exiting.\n`);
        exit(exitCode);
      }, terminalExitMs);
      // Unref'd so the window can never itself be why the process is still alive: it exists to end a
      // lifetime, not to hold one open.
      (abortTimer as { unref?: () => void }).unref?.();
      (exitTimer as { unref?: () => void }).unref?.();
      window = Object.freeze({ signal: controller.signal });
      return window;
    },
  });
}

export async function runKbDaemonMain(options: KbDaemonMainOptions = {}): Promise<number> {
  const startedAt = Date.now();
  const pluginRoot = options.pluginRoot ?? process.cwd();
  let nextParentRequestSeq = 1;
  const pendingParentRequests = new Map<string, PendingParentRequest>();
  const writeParentCancel = (requestId: string, reason: string): void => {
    writeControlMessage({
      type: KB_DAEMON_PARENT_REQUEST_MESSAGE,
      id: `parent:${nextParentRequestSeq++}`,
      method: 'curate.request.cancel',
      params: { requestId, reason },
    });
  };
  const sendParentRequest = (
    method: 'curate.assistant.complete' | 'curate.usage-budget.exhausted',
    params: KbDaemonCurateAssistantCompleteRequest | undefined,
    signal: AbortSignal | undefined,
  ): Promise<KbDaemonParentResponseMessage> => {
    const id = `parent:${nextParentRequestSeq++}`;
    if (signal?.aborted) {
      throw new AbortError({ stage: 'kb_daemon_parent_request', reason: signal.reason });
    }
    return new Promise<KbDaemonParentResponseMessage>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        pendingParentRequests.delete(id);
      };
      const rejectWith = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const onAbort = (): void => {
        writeParentCancel(id, errorMessage(signal?.reason ?? 'aborted'));
        rejectWith(new AbortError({ stage: 'kb_daemon_parent_request', reason: signal?.reason }));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      pendingParentRequests.set(id, {
        resolve: (message) => {
          cleanup();
          resolve(message);
        },
        reject: rejectWith,
      });
      writeControlMessage({
        type: KB_DAEMON_PARENT_REQUEST_MESSAGE,
        id,
        method,
        params,
      });
    });
  };
  const parentCurateAssistant: CurateAssistantPort = {
    async complete(request) {
      const response = await sendParentRequest(
        'curate.assistant.complete',
        {
          prompt: request.prompt,
          purpose: request.purpose,
          ...(request.model === undefined ? {} : { model: request.model }),
          ...(request.permissionMode === undefined ? {} : { permissionMode: request.permissionMode }),
        },
        request.signal,
      );
      if (!response.ok) {
        throwParentResponseError(response.error);
      }
      if (typeof response.result !== 'string') {
        throw new Error('KB daemon parent returned malformed curate assistant result.');
      }
      return response.result;
    },
  };
  const parentCurateUsageBudget: CurateUsageBudgetPort = {
    async isExhausted(signal) {
      const response = await sendParentRequest('curate.usage-budget.exhausted', undefined, signal);
      if (!response.ok) throwParentResponseError(response.error);
      if (typeof response.result !== 'boolean') {
        throw new Error('KB daemon parent returned malformed curate usage budget result.');
      }
      return response.result;
    },
  };
  const settleParentResponse = (response: KbDaemonParentResponseMessage): void => {
    const pending = pendingParentRequests.get(response.id);
    if (pending === undefined) {
      return;
    }
    pending.resolve(response);
  };
  const cancelPendingParentRequests = (message: string): void => {
    for (const [id, pending] of [...pendingParentRequests]) {
      writeParentCancel(id, message);
      pending.reject(new Error(message));
    }
  };
  const kbWriteHost = createKbDaemonWriteRuntimeHost({
    pluginRoot,
    curateAssistant: parentCurateAssistant,
    curateUsageBudget: parentCurateUsageBudget,
    backendNamespace: process.env.CORAL_KB_DAEMON_BACKEND_NAMESPACE,
    bundleHash: process.env.CORAL_KB_DAEMON_BUNDLE_HASH,
    onJournalEvents: (appended) =>
      writeControlMessage({
        type: KB_DAEMON_EVENT_MESSAGE,
        event: 'journal',
        appended: [...appended],
      }),
    onCorpusMutation: (publication) =>
      writeControlMessage({
        type: KB_DAEMON_EVENT_MESSAGE,
        event: 'corpus',
        publication,
      }),
  });
  const kbService = createKbDaemonRequestService({ pluginRoot, writeRuntime: kbWriteHost });
  const parentPid = options.parentPid ?? resolveKbDaemonParentPid(process.env.CORAL_KB_DAEMON_PARENT_PID);
  let resolveShutdown!: (code: number) => void;
  let settled = false;
  let parentWatchdog: IntervalHandle | null = null;
  const shutdown = new Promise<number>((resolve) => {
    resolveShutdown = resolve;
  });
  let stopPromise: Promise<void> | null = null;
  const terminal = createKbDaemonTerminalWindowAuthority();
  const stop = (code: number): void => {
    // Opened outside the `settled` latch deliberately. The latch belongs to the cleanup, which must run once;
    // the window belongs to the lifetime, which must end regardless of how that cleanup goes.
    const window = terminal.open(code);
    stopPromise ??= stopAsync(code, window.signal).finally(() => {
      stopPromise = null;
    });
  };
  const stopAsync = async (code: number, signal: AbortSignal): Promise<void> => {
    if (settled) {
      return;
    }
    settled = true;
    clearInterval(keepalive);
    if (parentWatchdog !== null) {
      clearInterval(parentWatchdog);
    }
    parentWatchdog = null;
    // Before disposal, not after it. Cleanup can await work that is itself waiting on a parent response, and
    // a cancellation sequenced after that await can never be the thing that releases it.
    cancelPendingParentRequests('KB daemon is shutting down.');
    try {
      await kbWriteHost.dispose({ signal });
    } catch (error: unknown) {
      process.stderr.write(`[kb-daemon] write runtime dispose failed: ${errorMessage(error)}\n`);
    } finally {
      resolveShutdown(code);
    }
  };
  const keepalive = setInterval(() => undefined, 60_000);
  parentWatchdog = startKbDaemonParentWatchdog({
    parentPid,
    onParentExit: () => stop(0),
  });

  const health = (): KbDaemonHealthResult => ({
    status: 'ready',
    pid: process.pid,
    startedAt,
    uptimeMs: Math.max(0, Date.now() - startedAt),
    kbRead: kbService.health(),
    kbWrite: kbWriteHost.health(),
  });
  const handleRequest = async (request: KbDaemonRequestMessage): Promise<void> => {
    switch (request.method) {
      case 'health':
        writeControlMessage({ type: KB_DAEMON_RESPONSE_MESSAGE, id: request.id, ok: true, result: health() });
        return;
      case 'shutdown':
        writeControlMessage({
          type: KB_DAEMON_RESPONSE_MESSAGE,
          id: request.id,
          ok: true,
          result: { status: 'shutting_down' },
        });
        stop(0);
        return;
      case 'kb.read':
        writeControlMessage({
          type: KB_DAEMON_RESPONSE_MESSAGE,
          id: request.id,
          ok: true,
          result: isKbDaemonKbReadRequest(request.params)
            ? await kbService.read(request.params)
            : {
                ok: false,
                code: 'invalid_request',
                message: 'Malformed KB daemon read request.',
              },
        });
        return;
      case 'kb.mutate':
        writeControlMessage({
          type: KB_DAEMON_RESPONSE_MESSAGE,
          id: request.id,
          ok: true,
          result: isKbDaemonKbMutationRequest(request.params)
            ? await kbService.mutate(request.params)
            : {
                ok: false,
                code: 'invalid_request',
                message: 'Malformed KB daemon mutation request.',
              },
        });
        return;
      case 'kb.abort': {
        const params = request.params as { jobIds?: unknown };
        const result = Array.isArray(params?.jobIds)
          ? kbWriteHost.abortJobs(params.jobIds.filter((jobId): jobId is string => typeof jobId === 'string'))
          : { aborted: [], notFound: [] };
        writeControlMessage({
          type: KB_DAEMON_RESPONSE_MESSAGE,
          id: request.id,
          ok: true,
          result: isKbDaemonAbortResult(result) ? result : { aborted: [], notFound: [] },
        });
        return;
      }
      case 'kb.jobs': {
        const result = { active: kbWriteHost.listActiveJobs() };
        writeControlMessage({
          type: KB_DAEMON_RESPONSE_MESSAGE,
          id: request.id,
          ok: true,
          result: isKbDaemonJobsResult(result) ? result : { active: [] },
        });
        return;
      }
      case 'kb.warmup':
        writeControlMessage({
          type: KB_DAEMON_RESPONSE_MESSAGE,
          id: request.id,
          ok: true,
          result: await kbService.warmup(),
        });
        return;
      case 'expansion.rpc':
        writeControlMessage({
          type: KB_DAEMON_RESPONSE_MESSAGE,
          id: request.id,
          ok: true,
          result: await handleKbDaemonExpansionRpcRequest(request.params, kbWriteHost),
        });
        return;
    }
  };
  let lineBuffer = '';
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk) => {
    lineBuffer += String(chunk);
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (isKbDaemonParentResponseMessage(parsed)) {
          settleParentResponse(parsed);
          continue;
        }
        if (isKbDaemonRequestMessage(parsed)) {
          void handleRequest(parsed).catch((error: unknown) => {
            writeControlMessage({
              type: KB_DAEMON_RESPONSE_MESSAGE,
              id: parsed.id,
              ok: false,
              error: kbDaemonErrorEnvelope(error),
            });
          });
          continue;
        }
      } catch {
        continue;
      }
    }
  });
  process.stdin.on('end', () => stop(0));
  process.on('SIGTERM', () => stop(0));
  process.on('SIGINT', () => stop(0));

  writeControlMessage({
    type: KB_DAEMON_READY_MESSAGE,
    pid: process.pid,
    startedAt,
    readyAt: Date.now(),
  });
  kbWriteHost.warmSearchRuntime();

  return shutdown;
}
