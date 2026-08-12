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

type IntervalHandle = ReturnType<typeof setInterval>;

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

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as { code?: unknown }).code === 'EPERM';
  }
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
  isAlive?: (pid: number) => boolean;
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
  const isAlive = options.isAlive ?? isProcessAlive;
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
    if (getCurrentParentPid() !== parentPid || !isAlive(parentPid)) {
      stopForParentExit();
    }
  }, intervalMs);
  (handle as { unref?: () => void }).unref?.();
  return handle;
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
  const stop = (code: number): void => {
    stopPromise ??= stopAsync(code).finally(() => {
      stopPromise = null;
    });
  };
  const stopAsync = async (code: number): Promise<void> => {
    if (settled) {
      return;
    }
    settled = true;
    clearInterval(keepalive);
    if (parentWatchdog !== null) {
      clearInterval(parentWatchdog);
    }
    parentWatchdog = null;
    try {
      await kbWriteHost.dispose();
    } catch (error: unknown) {
      process.stderr.write(`[kb-daemon] write runtime dispose failed: ${errorMessage(error)}\n`);
    } finally {
      cancelPendingParentRequests('KB daemon is shutting down.');
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
