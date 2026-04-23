import { spawn, type ChildProcess } from 'node:child_process';
import { delimiter } from 'node:path';

import { SIGTERM_GRACE_MS } from '#src/infra/process-constants.js';

function resolvePathKey(env: NodeJS.ProcessEnv): string | null {
  const keys = Object.keys(env).filter((key) => key.toUpperCase() === 'PATH');
  if (keys.includes('PATH')) {
    return 'PATH';
  }
  return keys.at(-1) ?? null;
}

function buildSpawnEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const pathKey = resolvePathKey(env);
  if (pathKey === null) {
    return { ...env };
  }

  const inheritedPathKey = resolvePathKey(process.env) ?? 'PATH';
  const requestedPath = env[pathKey];
  const inheritedPath = process.env[inheritedPathKey];
  if (
    typeof requestedPath !== 'string' ||
    requestedPath.length === 0 ||
    typeof inheritedPath !== 'string' ||
    inheritedPath.length === 0 ||
    requestedPath === inheritedPath ||
    requestedPath.endsWith(`${delimiter}${inheritedPath}`)
  ) {
    return { ...env };
  }

  return {
    ...env,
    [pathKey]: `${requestedPath}${delimiter}${inheritedPath}`,
  };
}

function safeKill(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    /* already exited */
  }
}

export async function spawnNodeScript<T = never>(opts: {
  scriptPath: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  parseStdout?: (stdout: string) => T;
}): Promise<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  parsed: T | undefined;
}> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [opts.scriptPath, ...opts.args], {
      cwd: process.cwd(),
      env: buildSpawnEnv(opts.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timeoutHandle: NodeJS.Timeout | null = null;
    let killHandle: NodeJS.Timeout | null = null;

    const clearTimers = (): void => {
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      if (killHandle !== null) {
        clearTimeout(killHandle);
        killHandle = null;
      }
    };

    const settle = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      fn();
    };

    const scheduleTimeoutKill = (): void => {
      if (settled) {
        return;
      }

      safeKill(child, 'SIGTERM');
      killHandle = setTimeout(() => {
        if (settled) {
          return;
        }
        safeKill(child, 'SIGKILL');
      }, SIGTERM_GRACE_MS);
      killHandle.unref?.();
    };

    if (child.stdout) {
      child.stdout.setEncoding('utf-8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
    }

    if (child.stderr) {
      child.stderr.setEncoding('utf-8');
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
    }

    child.once('error', (error) => {
      settle(() => reject(error));
    });

    child.once('close', (code, signal) => {
      let parsed: T | undefined = undefined;
      if (opts.parseStdout) {
        try {
          parsed = opts.parseStdout(stdout);
        } catch (error) {
          settle(() =>
            reject(
              error instanceof Error
                ? new Error(`Could not parse script output.\nstdout:\n${stdout}\nstderr:\n${stderr}`, { cause: error })
                : new Error(`Script output parser rejected with a non-Error value.\nstdout:\n${stdout}\nstderr:\n${stderr}`, {
                    cause: error,
                  }),
            ),
          );
          return;
        }
      }

      settle(() =>
        resolve({
          exitCode: code,
          signal,
          stdout,
          stderr,
          parsed,
        }),
      );
    });

    timeoutHandle = setTimeout(() => {
      scheduleTimeoutKill();
    }, opts.timeoutMs);
    timeoutHandle.unref?.();
  });
}
