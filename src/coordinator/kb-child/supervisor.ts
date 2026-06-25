import { basename, join } from 'node:path';
import { formatError } from '../../infra/error-format.js';
import { appendBuffer, requirePipedHandles, safeKill } from '../live/process-supervision.js';
import type { ChildProcessLike } from '../../infra/port-types.js';
import type { Runtime } from '../../runtime/ports.js';

export type KbChildPhase = 'disabled' | 'starting' | 'online' | 'restarting' | 'stopping' | 'stopped' | 'failed';

export type KbChildExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
  at: number;
  uptimeMs: number | null;
};

export type KbChildHealthSnapshot = {
  enabled: boolean;
  phase: KbChildPhase;
  generation: number;
  pid: number | null;
  startedAt: number | null;
  readyAt: number | null;
  entrypoint?: string;
  reason?: string;
  lastExit?: KbChildExit;
  lastError?: string;
};

export interface KbChildSupervisor {
  read(): KbChildHealthSnapshot;
  start(): Promise<KbChildHealthSnapshot>;
  stop(reason?: string, options?: { signal?: AbortSignal }): Promise<KbChildHealthSnapshot>;
  restart(reason?: string): Promise<KbChildHealthSnapshot>;
  dispose(reason?: string, options?: { signal?: AbortSignal }): Promise<void>;
}

type KbChildSupervisorOptions = {
  runtime: Runtime;
  pluginRoot: string;
  instanceId?: string;
  entrypoint?: string;
  command?: string;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
  log?: (message: string) => void;
};

const READY_MESSAGE_TYPE = 'coral.kb_child.ready';
const DEFAULT_START_TIMEOUT_MS = 5_000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;

export function resolveDefaultKbChildEntrypoint(pluginRoot: string, currentEntrypoint = process.argv[1]): string {
  if (typeof currentEntrypoint === 'string' && basename(currentEntrypoint) === 'coral-backend.cjs') {
    return currentEntrypoint;
  }
  return join(pluginRoot, 'bridge', 'coral-backend.cjs');
}

export function createDisabledKbChildSupervisor(reason = 'disabled'): KbChildSupervisor {
  const snapshot: KbChildHealthSnapshot = {
    enabled: false,
    phase: 'disabled',
    generation: 0,
    pid: null,
    startedAt: null,
    readyAt: null,
    reason,
  };

  return {
    read: () => ({ ...snapshot }),
    start: async () => ({ ...snapshot }),
    stop: async () => ({ ...snapshot }),
    restart: async () => ({ ...snapshot }),
    dispose: async () => undefined,
  };
}

function isReadyMessage(value: unknown): value is { type: typeof READY_MESSAGE_TYPE; pid?: number; readyAt?: number } {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.type === READY_MESSAGE_TYPE &&
    (record.pid === undefined || Number.isInteger(record.pid)) &&
    (record.readyAt === undefined || Number.isFinite(record.readyAt))
  );
}

function withAbortableTimeout(
  runtime: Runtime,
  ms: number,
  signal: AbortSignal | undefined,
): Promise<'timeout' | 'aborted'> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve('aborted');
      return;
    }
    const timeout = runtime.time.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve('timeout');
    }, ms);
    timeout.unref?.();
    const onAbort = (): void => {
      runtime.time.clearTimeout(timeout);
      resolve('aborted');
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function waitForClose(child: ChildProcessLike): Promise<void> {
  return new Promise((resolve) => {
    child.on('close', () => resolve());
  });
}

export function createKbChildSupervisor(options: KbChildSupervisorOptions): KbChildSupervisor {
  const { runtime, pluginRoot } = options;
  const command = options.command ?? process.execPath;
  const entrypoint = options.entrypoint ?? resolveDefaultKbChildEntrypoint(pluginRoot);
  const startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  const stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  const log = options.log ?? (() => undefined);

  let phase: KbChildPhase = 'stopped';
  let generation = 0;
  let child: ChildProcessLike | null = null;
  let pid: number | null = null;
  let startedAt: number | null = null;
  let readyAt: number | null = null;
  let lastExit: KbChildExit | undefined;
  let lastError: string | undefined;
  let operation: Promise<KbChildHealthSnapshot> | null = null;
  let stderrBuffer = '';

  const read = (): KbChildHealthSnapshot => ({
    enabled: true,
    phase,
    generation,
    pid,
    startedAt,
    readyAt,
    entrypoint,
    ...(lastExit === undefined ? {} : { lastExit }),
    ...(lastError === undefined ? {} : { lastError }),
  });

  const setFailure = (message: string): void => {
    lastError = message;
    phase = 'failed';
    log(`[kb-child] ${message}`);
  };

  const runExclusive = (fn: () => Promise<KbChildHealthSnapshot>): Promise<KbChildHealthSnapshot> => {
    const previous = operation ?? Promise.resolve(read());
    const next = previous.catch(() => read()).then(fn);
    const wrapped = next.finally(() => {
      if (operation === wrapped) {
        operation = null;
      }
    });
    operation = wrapped;
    return wrapped;
  };

  const startNow = async (): Promise<KbChildHealthSnapshot> => {
    if (child !== null && (phase === 'starting' || phase === 'online')) {
      return read();
    }

    generation += 1;
    phase = 'starting';
    startedAt = runtime.time.now();
    readyAt = null;
    lastError = undefined;
    stderrBuffer = '';

    let spawned: ChildProcessLike | null = null;
    try {
      spawned = runtime.process.spawn({
        command,
        args: [entrypoint, '--kb-child'],
        cwd: pluginRoot,
        envAdditions: {
          CORAL_KB_CHILD: '1',
          CORAL_KB_CHILD_GENERATION: String(generation),
          CORAL_KB_CHILD_PARENT_PID: String(process.pid),
          ...(options.instanceId === undefined ? {} : { CORAL_KB_CHILD_INSTANCE_ID: options.instanceId }),
        },
      });
      requirePipedHandles(spawned, command);
    } catch (error: unknown) {
      if (spawned !== null) {
        safeKill(spawned, 'SIGTERM');
      }
      child = null;
      pid = null;
      setFailure(`spawn failed: ${formatError(error)}`);
      return read();
    }
    if (spawned === null) {
      setFailure('spawn did not return a child process');
      return read();
    }

    child = spawned;
    pid = spawned.pid ?? null;
    const activeGeneration = generation;
    const startedAtForExit = startedAt;
    const { stdout, stderr } = requirePipedHandles(spawned, command);
    stdout.setEncoding('utf-8');
    stderr.setEncoding('utf-8');

    const readyPromise = new Promise<'ready' | 'closed' | 'error' | 'timeout'>((resolve) => {
      let settled = false;
      let lineBuffer = '';
      const settle = (result: 'ready' | 'closed' | 'error' | 'timeout'): void => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(result);
      };

      const timeout = runtime.time.setTimeout(() => {
        settle('timeout');
      }, startTimeoutMs);
      timeout.unref?.();

      stdout.on('data', (chunk) => {
        lineBuffer += String(chunk);
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim().length === 0) {
            continue;
          }
          try {
            const parsed = JSON.parse(line) as unknown;
            if (isReadyMessage(parsed)) {
              if (activeGeneration === generation && child === spawned) {
                pid = parsed.pid ?? spawned.pid ?? null;
                readyAt = parsed.readyAt ?? runtime.time.now();
                phase = 'online';
              }
              runtime.time.clearTimeout(timeout);
              settle('ready');
              return;
            }
          } catch {
            // Non-control stdout is ignored; stderr is retained for diagnostics.
          }
        }
      });

      stderr.on('data', (chunk) => {
        stderrBuffer = appendBuffer(stderrBuffer, String(chunk));
      });

      spawned.on('error', (error) => {
        lastError = `child error: ${formatError(error)}`;
        runtime.time.clearTimeout(timeout);
        settle('error');
      });

      spawned.on('close', (code, signal) => {
        runtime.time.clearTimeout(timeout);
        lastExit = {
          code,
          signal,
          at: runtime.time.now(),
          uptimeMs: startedAtForExit === null ? null : Math.max(0, runtime.time.now() - startedAtForExit),
        };
        if (child === spawned) {
          child = null;
          pid = null;
          readyAt = null;
          if (phase === 'stopping') {
            phase = 'stopped';
          } else {
            phase = 'failed';
            lastError = stderrBuffer.trim().length > 0 ? stderrBuffer.trim() : 'child exited';
          }
        }
        settle('closed');
      });
    });

    const result = await readyPromise;
    if (result === 'error' && child === spawned) {
      setFailure(lastError ?? 'child start failed');
    }
    if (result === 'timeout' && child === spawned) {
      setFailure(`child did not become ready within ${startTimeoutMs}ms`);
      safeKill(spawned, 'SIGTERM');
    }

    return read();
  };

  const stopNow = async (reason = 'stop', signal?: AbortSignal): Promise<KbChildHealthSnapshot> => {
    const activeChild = child;
    if (activeChild === null) {
      phase = 'stopped';
      pid = null;
      readyAt = null;
      return read();
    }

    phase = 'stopping';
    const closed = waitForClose(activeChild).then(() => 'closed' as const);
    try {
      activeChild.stdin?.end(`shutdown ${reason}\n`);
    } catch {
      safeKill(activeChild, 'SIGTERM');
    }

    const result = await Promise.race([closed, withAbortableTimeout(runtime, stopTimeoutMs, signal)]);
    if (result !== 'closed' && child === activeChild) {
      setFailure(
        result === 'aborted'
          ? 'child stop aborted by shutdown budget'
          : `child stop timed out after ${stopTimeoutMs}ms`,
      );
      safeKill(activeChild, 'SIGTERM');
    }
    return read();
  };

  return {
    read,
    start: () => runExclusive(startNow),
    stop: (reason, stopOptions) => runExclusive(() => stopNow(reason, stopOptions?.signal)),
    restart: (reason = 'restart') =>
      runExclusive(async () => {
        phase = 'restarting';
        await stopNow(reason);
        if (child !== null) {
          return read();
        }
        return startNow();
      }),
    dispose: async (reason = 'dispose', disposeOptions) => {
      await runExclusive(() => stopNow(reason, disposeOptions?.signal));
    },
  };
}

export function createDefaultKbChildSupervisor(options: KbChildSupervisorOptions): KbChildSupervisor {
  if (options.runtime.env.get('CORAL_KB_CHILD_ENABLE') === '0') {
    return createDisabledKbChildSupervisor('disabled by CORAL_KB_CHILD_ENABLE=0');
  }

  const entrypoint = options.entrypoint ?? resolveDefaultKbChildEntrypoint(options.pluginRoot);
  if (!options.runtime.storage.existsSync(entrypoint)) {
    return createDisabledKbChildSupervisor(`entrypoint not found: ${entrypoint}`);
  }

  return createKbChildSupervisor({ ...options, entrypoint });
}
