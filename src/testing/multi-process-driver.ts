import { spawn } from 'node:child_process';
import { join } from 'node:path';

export interface WorkerResult {
  readonly workerId: number;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly result: Record<string, unknown>;
}

function parseWorkerResult(stdout: string): Record<string, unknown> {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    throw new Error('Worker did not emit JSON output.');
  }

  const parsed = JSON.parse(lines[lines.length - 1] ?? '') as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Worker JSON output must be an object.');
  }

  return parsed as Record<string, unknown>;
}

export async function spawnEquipWorkers(opts: {
  home: string;
  workers: number;
  catalog: string;
}): Promise<WorkerResult[]> {
  const scriptPath = join(process.cwd(), 'scripts', 'equip-driver.mjs');
  const binDir = join(opts.home, 'bin');

  return await Promise.all(
    Array.from({ length: opts.workers }, (_, workerId) =>
      new Promise<WorkerResult>((resolve, reject) => {
        const child = spawn(process.execPath, [scriptPath, opts.catalog], {
          cwd: process.cwd(),
          env: {
            ...process.env,
            HOME: opts.home,
            USERPROFILE: opts.home,
            TMPDIR: opts.home,
            CORAL_HOME: opts.home,
            CLAUDE_PLUGIN_ROOT: process.cwd(),
            CORAL_WORKER_ID: String(workerId),
            PATH: `${binDir}:${process.env.PATH ?? ''}`,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';

        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`Timed out waiting for equip worker ${workerId}.\n${stdout}${stderr}`));
        }, 15_000);
        timer.unref?.();

        child.stdout.setEncoding('utf-8');
        child.stderr.setEncoding('utf-8');
        child.stdout.on('data', (chunk: string) => {
          stdout += chunk;
        });
        child.stderr.on('data', (chunk: string) => {
          stderr += chunk;
        });
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('close', (code, signal) => {
          clearTimeout(timer);

          let result: Record<string, unknown>;
          try {
            result = parseWorkerResult(stdout);
          } catch (error) {
            reject(
              error instanceof Error
                ? new Error(`Could not parse worker ${workerId} output.\nstdout:\n${stdout}\nstderr:\n${stderr}`, {
                    cause: error,
                  })
                : new Error(`Worker ${workerId} produced non-Error rejection.\nstdout:\n${stdout}\nstderr:\n${stderr}`, {
                    cause: error,
                  }),
            );
            return;
          }

          resolve({
            workerId,
            exitCode: code,
            signal,
            stdout,
            stderr,
            result,
          });
        });
      }),
    ),
  );
}
