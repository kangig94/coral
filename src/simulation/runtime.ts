import { composeChildEnv } from '../shared/env-sanitize.js';
import { MAX_BUFFER, SIGTERM_GRACE_MS } from '../shared/process-constants.js';
import type { ExecResult, Runtime, RuntimeExecOptions, RuntimeProcess } from '../runtime/ports.js';
import { InMemoryStorage, type InMemoryRoots } from '../execution/simulation/core/memory-storage.js';
import { MockProcessSpawner } from '../execution/simulation/core/mock-process.js';
import { InMemoryObserver, InMemoryPaths, SealedEnv, SequentialIds } from '../execution/simulation/core/runtime-doubles.js';
import { DEFAULT_EPOCH_MS, VirtualTime } from '../execution/simulation/core/virtual-time.js';

const SIMULATION_ENV_BUDGET_BYTES = 2 * 1024 * 1024;

export interface SimulationRuntimeOptions {
  epochMs?: number;
  env?: Record<string, string>;
  roots?: InMemoryRoots;
}

export class SimulationRuntime implements Runtime {
  readonly time: VirtualTime;
  readonly storage: InMemoryStorage;
  readonly paths: InMemoryPaths;
  readonly ids: SequentialIds;
  readonly env: SealedEnv;
  readonly observer: InMemoryObserver;
  readonly spawner: MockProcessSpawner;
  readonly process: RuntimeProcess;

  constructor(options: SimulationRuntimeOptions = {}) {
    const roots: InMemoryRoots = options.roots ?? {};
    this.time = new VirtualTime(options.epochMs ?? DEFAULT_EPOCH_MS);
    this.env = new SealedEnv(options.env);
    this.paths = new InMemoryPaths(roots);
    this.storage = new InMemoryStorage(this.time, roots);
    this.ids = new SequentialIds();
    this.observer = new InMemoryObserver();
    const inheritedEnv = this.env.fullSnapshot();
    this.spawner = new MockProcessSpawner(this.time, this.storage, {
      buildDurableEnv: (envAdditions) =>
        composeChildEnv({ ...inheritedEnv }, envAdditions ?? {}, SIMULATION_ENV_BUDGET_BYTES, new Set<string>()),
    });
    const simulationProcess = {} as RuntimeProcess;
    simulationProcess.spawn = (spawnOptions) => {
      const child = this.spawner.spawn(spawnOptions);
      this.observer.emit({
        child,
        command: spawnOptions.command,
        args: [...spawnOptions.args],
        ...(spawnOptions.envAdditions ? { env: { ...spawnOptions.envAdditions } } : {}),
      });
      return child;
    };
    simulationProcess.kill = (pid, signal) => {
      this.spawner.kill(pid, signal);
    };
    simulationProcess.isAlive = (pid) => this.spawner.isAlive(pid);
    simulationProcess.durable = this.spawner.durable;

    simulationProcess.exec = (command, args, options = {}) => {
      const execOptions: RuntimeExecOptions = { ...options };
      execOptions.maxBuffer ??= MAX_BUFFER;
      const maxBuffer = execOptions.maxBuffer;
      const encoding = execOptions.encoding ?? 'utf-8';

      return new Promise<ExecResult>((resolve) => {
        let stdout = '';
        let stderr = '';
        let resolved = false;
        let timeoutHandle: ReturnType<SimulationRuntime['time']['setTimeout']> | null = null;
        let killTimer: ReturnType<SimulationRuntime['time']['setTimeout']> | null = null;
        let wrapperKilled: 'timeout' | 'maxBuffer' | null = null;

        const child = simulationProcess.spawn({
          command,
          args,
          cwd: execOptions.cwd,
          env: execOptions.env,
          inheritEnv: execOptions.inheritEnv,
          mode: 'piped',
        });

        child.stdin?.end();

        const clearTimers = (): void => {
          this.time.clearTimeout(timeoutHandle);
          timeoutHandle = null;
          this.time.clearTimeout(killTimer);
          killTimer = null;
        };

        const finish = (result: ExecResult): void => {
          if (resolved) {
            return;
          }
          resolved = true;
          clearTimers();
          resolve(result);
        };

        const scheduleKill = (reason: 'timeout' | 'maxBuffer'): void => {
          if (resolved || wrapperKilled !== null || child.pid === undefined) {
            return;
          }
          wrapperKilled = reason;
          simulationProcess.kill(child.pid, 'SIGTERM');
          killTimer = this.time.setTimeout(() => {
            if (resolved || child.pid === undefined) {
              return;
            }
            simulationProcess.kill(child.pid, 'SIGKILL');
          }, SIGTERM_GRACE_MS);
          killTimer.unref?.();
        };

        const appendOutput = (
          current: string,
          chunk: string | Buffer,
        ): { next: string; overflowed: boolean } => {
          if (wrapperKilled !== null) {
            return { next: current, overflowed: false };
          }

          const text = typeof chunk === 'string' ? chunk : chunk.toString(encoding);
          const currentBytes = Buffer.byteLength(current, encoding);
          const chunkBytes = Buffer.byteLength(text, encoding);
          if (currentBytes + chunkBytes <= maxBuffer) {
            return { next: current + text, overflowed: false };
          }

          let next = current;
          let remainingBytes = maxBuffer - currentBytes;
          if (remainingBytes > 0) {
            for (const character of text) {
              const characterBytes = Buffer.byteLength(character, encoding);
              if (characterBytes > remainingBytes) {
                break;
              }
              next += character;
              remainingBytes -= characterBytes;
            }
          }

          return { next, overflowed: true };
        };

        if (child.stdout) {
          child.stdout.setEncoding(encoding);
          child.stdout.on('data', (chunk) => {
            const result = appendOutput(stdout, chunk);
            stdout = result.next;
            if (result.overflowed) {
              scheduleKill('maxBuffer');
            }
          });
        }

        if (child.stderr) {
          child.stderr.setEncoding(encoding);
          child.stderr.on('data', (chunk) => {
            const result = appendOutput(stderr, chunk);
            stderr = result.next;
            if (result.overflowed) {
              scheduleKill('maxBuffer');
            }
          });
        }

        child.on('close', (status) => {
          const error =
            wrapperKilled === 'timeout'
              ? new Error(`timeout: ${command}`)
              : wrapperKilled === 'maxBuffer'
                ? new Error(`maxBuffer exceeded: ${command}`)
                : undefined;
          finish({
            stdout,
            stderr,
            status: error ? null : status,
            ...(error ? { error } : {}),
          });
        });

        child.on('error', (error) => {
          finish({
            stdout: '',
            stderr: '',
            status: null,
            error,
          });
        });

        if (execOptions.timeout !== undefined) {
          timeoutHandle = this.time.setTimeout(() => {
            scheduleKill('timeout');
          }, execOptions.timeout);
          timeoutHandle.unref?.();
        }
      });
    };

    simulationProcess.execSync = (command, args, options = {}) => {
      const execOptions: RuntimeExecOptions = { ...options };
      execOptions.maxBuffer ??= MAX_BUFFER;
      execOptions.encoding ??= 'utf-8';
      return this.spawner.execSync(command, args, execOptions);
    };

    this.process = simulationProcess;
  }
}
