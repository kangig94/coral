import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  createSessionDir,
  createProgressCursor,
  writeSessionResult,
  writeSessionError,
  readSessionStatus,
  resolveSessionDir,
  readProgressEvents,
  formatElapsed,
  PROGRESS_FILE,
  type ProgressCursor,
  type SessionStatus,
} from './progress.js';
import { SessionManager } from './session-manager.js';
import type { CompletionMetadata, SessionProvider } from './types.js';
import { type McpResult, textResult, jsonResult } from '../shared/mcp-utils.js';

export type OnEventCallback = (line: string) => void;

export type ActiveSession = {
  provider: SessionProvider;
  sessionDir: string;
  controller: AbortController;
  sessionName: string;
  threadId?: string;
  terminalState: 'running' | 'terminalizing' | 'completed' | 'error';
};

export type LaunchJobOptions<T> = {
  provider: SessionProvider;
  sessionLabel: string;
  workingDirectory: string;
  handler: (signal: AbortSignal, onEvent: OnEventCallback) => Promise<T>;
  mgr: SessionManager;
  makeOnEvent: (ctx: {
    provider: SessionProvider;
    sessionId: string;
    sessionDir: string;
    progressFile: string;
  }) => OnEventCallback;
  extractCompletion: (
    result: T,
    sessionLabel: string,
  ) => { responseText: string; metadata: CompletionMetadata; sessionId?: string };
};

export type WaitInput = {
  sessions: string[];
  timeout_seconds?: number;
};

export const activeSessions = new Map<string, ActiveSession>();

/** Atomically transition a session from 'running' to 'terminalizing'. Returns true if claim succeeded. */
export function tryClaimTerminalWrite(id: string): boolean {
  const entry = activeSessions.get(id);
  if (!entry || entry.terminalState !== 'running') return false;
  entry.terminalState = 'terminalizing';
  return true;
}

export const shutdownSignal = new AbortController();

export function launchJob<T>(options: LaunchJobOptions<T>): McpResult {
  const { id, dir } = createSessionDir(options.sessionLabel, options.provider);
  const controller = new AbortController();
  const entry: ActiveSession = {
    provider: options.provider,
    sessionDir: dir,
    controller,
    sessionName: options.sessionLabel,
    terminalState: 'running',
  };
  activeSessions.set(id, entry);

  const progressFile = join(dir, PROGRESS_FILE);
  const onEvent = options.makeOnEvent({
    provider: options.provider,
    sessionId: id,
    sessionDir: dir,
    progressFile,
  });

  options.handler(controller.signal, onEvent)
    .then((result) => {
      if (!tryClaimTerminalWrite(id)) return;

      const completion = options.extractCompletion(result, options.sessionLabel);
      writeSessionResult(dir, completion.responseText, {
        ...completion.metadata,
        session_name: options.sessionLabel,
      });

      if (completion.sessionId) {
        entry.threadId = completion.sessionId;
        const model = typeof completion.metadata.model === 'string' ? completion.metadata.model : 'unknown';
        options.mgr.register(
          options.provider,
          id,
          options.sessionLabel,
          completion.sessionId,
          model,
          options.workingDirectory,
        );
      }

      entry.terminalState = 'completed';
    })
    .catch((err: unknown) => {
      if (!tryClaimTerminalWrite(id)) return;
      writeSessionError(dir, err instanceof Error ? err.message : String(err));
      entry.terminalState = 'error';
    })
    .finally(() => {
      activeSessions.delete(id);
    });

  return jsonResult({ session: id, session_dir: dir, session_name: options.sessionLabel, status: 'running' });
}

export async function handleWait(
  input: WaitInput,
  notify?: (n: { method: string; params: Record<string, unknown> }) => Promise<void>,
  progressToken?: string | number,
): Promise<McpResult> {
  const { sessions, timeout_seconds = 600 } = input;

  const sessionDirs = new Map<string, string>();
  const sessionMeta = new Map<string, { name: string; startedAt: number | undefined }>();
  const cursors = new Map<string, ProgressCursor>();
  const lastSent = new Map<string, string>();

  for (const id of sessions) {
    const unknownSession = `Unknown session: "${id}". No session directory found.`;
    let dir: string;
    try {
      dir = resolveSessionDir(id);
    } catch {
      return textResult(unknownSession, true);
    }
    if (!existsSync(dir)) {
      return textResult(unknownSession, true);
    }

    const status = readSessionStatus(dir);

    sessionDirs.set(id, dir);
    sessionMeta.set(id, { name: status.session_name ?? id, startedAt: status.startedAt });
    cursors.set(id, createProgressCursor());
  }

  let notifCounter = 0;
  const startMs = Date.now();
  const timeoutMs = timeout_seconds * 1000;

  const timeoutResponse = (): McpResult => {
    const running = sessions.filter((id) => {
      const dir = sessionDirs.get(id);
      return dir != null && readSessionStatus(dir).status === 'running';
    });
    return jsonResult({ status: 'timeout', running_sessions: running });
  };

  while (true) {
    if (shutdownSignal.signal.aborted) {
      return timeoutResponse();
    }

    if (Date.now() - startMs >= timeoutMs) {
      return timeoutResponse();
    }

    let completedId: string | null = null;
    let completedStatus: SessionStatus | null = null;

    for (const id of sessions) {
      const dir = sessionDirs.get(id)!;
      const progressFile = join(dir, PROGRESS_FILE);
      const cursor = cursors.get(id)!;

      if (progressToken != null && notify != null) {
        const events = readProgressEvents(progressFile, cursor);
        for (const evt of events) {
          const previousMessage = lastSent.get(id);
          if (previousMessage === evt.message) continue;

          const meta = sessionMeta.get(id)!;
          const elapsed = formatElapsed(meta.startedAt);
          const tag = elapsed ? `${elapsed}: ${meta.name}` : meta.name;
          lastSent.set(id, evt.message);
          void notify({
            method: 'notifications/progress',
            params: {
              progressToken,
              progress: ++notifCounter,
              message: `[${tag}] ${evt.message}`,
            },
          }).catch(() => {});
        }
      } else {
        // Keep cursor advancement in sync even when notifications are disabled.
        readProgressEvents(progressFile, cursor);
      }

      const sessionStatus = readSessionStatus(dir);
      if ((sessionStatus.status === 'completed' || sessionStatus.status === 'error') && completedId === null) {
        completedId = id;
        completedStatus = sessionStatus;
      }
    }

    if (completedId !== null && completedStatus !== null) {
      const dir = sessionDirs.get(completedId)!;
      return jsonResult({
        status: completedStatus.status,
        completed_session: completedId,
        session_dir: dir,
        session_name: completedStatus.session_name ?? completedId,
      });
    }

    await new Promise<void>((resolve) => {
      const onAbort = () => {
        clearTimeout(timer);
        shutdownSignal.signal.removeEventListener('abort', onAbort);
        resolve();
      };
      const timer = setTimeout(() => {
        shutdownSignal.signal.removeEventListener('abort', onAbort);
        resolve();
      }, 500);
      shutdownSignal.signal.addEventListener('abort', onAbort);
    });
  }
}
