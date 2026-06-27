import {
  KB_CHILD_EVENT_MESSAGE,
  KB_CHILD_READY_MESSAGE,
  KB_CHILD_RESPONSE_MESSAGE,
  encodeKbChildMessage,
  isKbChildAbortResult,
  isKbChildExpansionRequest,
  isKbChildJobsResult,
  isKbChildKbMutationRequest,
  isKbChildKbReadRequest,
  isKbChildRequestMessage,
  type KbChildHealthResult,
  type KbChildControlMessage,
  type KbChildRequestMessage,
} from './protocol.js';
import { createKbChildReadService } from './read-handler.js';
import { createKbChildWriteRuntimeHost } from './write-runtime.js';
import { errorMessage } from '../../infra/error-format.js';

const DEFAULT_PARENT_WATCHDOG_INTERVAL_MS = 1_000;

type IntervalHandle = ReturnType<typeof setInterval>;

export type KbChildMainOptions = {
  pluginRoot?: string;
  parentPid?: number | null;
};

function writeControlMessage(message: KbChildControlMessage): void {
  process.stdout.write(encodeKbChildMessage(message));
}

export function resolveKbChildParentPid(value: string | undefined, selfPid = process.pid): number | null {
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

export type KbChildParentWatchdogOptions = {
  parentPid: number | null | undefined;
  intervalMs?: number;
  isAlive?: (pid: number) => boolean;
  getCurrentParentPid?: () => number;
  setIntervalFn?: (fn: () => void, ms: number) => IntervalHandle;
  clearIntervalFn?: (handle: IntervalHandle) => void;
  onParentExit: () => void;
};

export function startKbChildParentWatchdog(options: KbChildParentWatchdogOptions): IntervalHandle | null {
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

export async function runKbChildMain(options: KbChildMainOptions = {}): Promise<number> {
  const startedAt = Date.now();
  const pluginRoot = options.pluginRoot ?? process.cwd();
  const kbWriteHost = createKbChildWriteRuntimeHost({
    pluginRoot,
    backendNamespace: process.env.CORAL_KB_CHILD_BACKEND_NAMESPACE,
    bundleHash: process.env.CORAL_KB_CHILD_BUNDLE_HASH,
    onJournalEvents: (appended) =>
      writeControlMessage({
        type: KB_CHILD_EVENT_MESSAGE,
        event: 'journal',
        appended: [...appended],
      }),
    onCorpusMutation: (publication) =>
      writeControlMessage({
        type: KB_CHILD_EVENT_MESSAGE,
        event: 'corpus',
        publication,
      }),
  });
  const kbService = createKbChildReadService({ pluginRoot, writeRuntime: kbWriteHost });
  const parentPid = options.parentPid ?? resolveKbChildParentPid(process.env.CORAL_KB_CHILD_PARENT_PID);
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
      process.stderr.write(`[kb-child] write runtime dispose failed: ${errorMessage(error)}\n`);
    } finally {
      resolveShutdown(code);
    }
  };
  const keepalive = setInterval(() => undefined, 60_000);
  parentWatchdog = startKbChildParentWatchdog({
    parentPid,
    onParentExit: () => stop(0),
  });

  const health = (): KbChildHealthResult => ({
    status: 'ready',
    pid: process.pid,
    startedAt,
    uptimeMs: Math.max(0, Date.now() - startedAt),
    kbRead: kbService.health(),
    kbWrite: kbWriteHost.health(),
  });
  const handleRequest = async (request: KbChildRequestMessage): Promise<void> => {
    switch (request.method) {
      case 'health':
        writeControlMessage({ type: KB_CHILD_RESPONSE_MESSAGE, id: request.id, ok: true, result: health() });
        return;
      case 'shutdown':
        writeControlMessage({
          type: KB_CHILD_RESPONSE_MESSAGE,
          id: request.id,
          ok: true,
          result: { status: 'shutting_down' },
        });
        stop(0);
        return;
      case 'kb.read':
        writeControlMessage({
          type: KB_CHILD_RESPONSE_MESSAGE,
          id: request.id,
          ok: true,
          result: isKbChildKbReadRequest(request.params)
            ? await kbService.read(request.params)
            : {
                ok: false,
                code: 'invalid_request',
                message: 'Malformed KB child read request.',
              },
        });
        return;
      case 'kb.mutate':
        writeControlMessage({
          type: KB_CHILD_RESPONSE_MESSAGE,
          id: request.id,
          ok: true,
          result: isKbChildKbMutationRequest(request.params)
            ? await kbService.mutate(request.params)
            : {
                ok: false,
                code: 'invalid_request',
                message: 'Malformed KB child mutation request.',
              },
        });
        return;
      case 'kb.abort': {
        const params = request.params as { jobIds?: unknown };
        const result = Array.isArray(params?.jobIds)
          ? kbWriteHost.abortJobs(params.jobIds.filter((jobId): jobId is string => typeof jobId === 'string'))
          : { aborted: [], notFound: [] };
        writeControlMessage({
          type: KB_CHILD_RESPONSE_MESSAGE,
          id: request.id,
          ok: true,
          result: isKbChildAbortResult(result) ? result : { aborted: [], notFound: [] },
        });
        return;
      }
      case 'kb.jobs': {
        const result = { active: kbWriteHost.listActiveJobs() };
        writeControlMessage({
          type: KB_CHILD_RESPONSE_MESSAGE,
          id: request.id,
          ok: true,
          result: isKbChildJobsResult(result) ? result : { active: [] },
        });
        return;
      }
      case 'kb.warmup':
        writeControlMessage({
          type: KB_CHILD_RESPONSE_MESSAGE,
          id: request.id,
          ok: true,
          result: await kbService.warmup(),
        });
        return;
      case 'expansion.rpc':
        writeControlMessage({
          type: KB_CHILD_RESPONSE_MESSAGE,
          id: request.id,
          ok: true,
          result: isKbChildExpansionRequest(request.params)
            ? await kbWriteHost.expansionRpc(request.params)
            : {
                ok: false,
                code: 'invalid_request',
                message: 'Malformed KB child expansion request.',
              },
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
        if (isKbChildRequestMessage(parsed)) {
          void handleRequest(parsed).catch((error: unknown) => {
            writeControlMessage({
              type: KB_CHILD_RESPONSE_MESSAGE,
              id: parsed.id,
              ok: false,
              error: { message: errorMessage(error) },
            });
          });
          continue;
        }
      } catch {
        // Plain-text shutdown remains supported for direct smoke tests and old supervisors.
      }
      if (trimmed.includes('shutdown')) {
        stop(0);
      }
    }
  });
  process.stdin.on('end', () => stop(0));
  process.on('SIGTERM', () => stop(0));
  process.on('SIGINT', () => stop(0));

  writeControlMessage({
    type: KB_CHILD_READY_MESSAGE,
    pid: process.pid,
    startedAt,
    readyAt: Date.now(),
  });

  return shutdown;
}
