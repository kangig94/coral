import { EventEmitter } from 'node:events';
import { join, normalize } from 'node:path';
import { PassThrough } from 'node:stream';
import type { DurableCliRuntimeRecord, DurableProcessExit } from '../../runtime/durable-runtime.js';
import { attachSpawnRecordingMetadata } from '../../infra/process/spawn-recording.js';
import { nowIsoString } from '../../infra/time.js';
import type {
  ChildOutputChunk,
  MockDurableScript,
  MockExecSyncScript,
  MockKillAction,
  MockSpawnContext,
  MockSpawnScript,
} from './mock-script-types.js';
import type {
  ChildProcessLike,
  ChildReadableLike,
  ChildStdinLike,
  DurableExecutionTransport,
  DurableLaunchOptions,
  DurableLaunchResult,
  ExecResult,
  RuntimeExecOptions,
  RuntimeSpawnOptions,
  RuntimeTimerHandle,
} from '../../runtime/ports.js';
import { createDeferred, type Deferred } from './test-deferred.js';
import { toError } from './constants.js';
import type { InMemoryStorage } from './memory-storage.js';
import { type VirtualTime } from './virtual-time.js';
export type { ChildOutputChunk, MockDurableScript, MockExecSyncScript, MockKillAction, MockSpawnScript } from './mock-script-types.js';

export type { MockSpawnContext } from './mock-script-types.js';

type ProcessExitOutcome = {
  delayMs?: number;
  exitCode?: number | null;
  signal?: string | null;
};

type RegisteredProcess = {
  pid: number;
  alive: boolean;
  closed: boolean;
  timers: Set<RuntimeTimerHandle>;
  child: MockChildProcess | null;
  killActions: MockKillAction[];
  complete: (outcome: ProcessExitOutcome) => void;
  waitForExit: Deferred<DurableProcessExit> | null;
};

type MockProcessSpawnerOptions = {
  buildDurableEnv: (envAdditions?: Record<string, string>) => Record<string, string>;
};

function asChunks(value: string | ChildOutputChunk[] | undefined): ChildOutputChunk[] {
  if (value === undefined) {
    return [];
  }
  if (typeof value === 'string') {
    return [{ delayMs: 0, data: value }];
  }
  return value.map((chunk) => ({ delayMs: chunk.delayMs ?? 0, data: chunk.data }));
}

export class MockStdin extends EventEmitter implements ChildStdinLike {
  destroyed = false;
  readonly writes: string[] = [];

  write(chunk: string | Uint8Array): boolean {
    if (this.destroyed) {
      this.emit('error', new Error('stdin is destroyed'));
      return false;
    }
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
    this.writes.push(text);
    this.emit('write', text);
    return true;
  }

  end(chunk?: string | Uint8Array): void {
    if (chunk !== undefined) {
      this.write(chunk);
    }
    this.destroyed = true;
    this.emit('end');
  }
}

export class MockChildProcess extends EventEmitter implements ChildProcessLike {
  readonly stdin: ChildStdinLike | null;
  readonly stdout: ChildReadableLike | null;
  readonly stderr: ChildReadableLike | null;

  constructor(
    readonly pid: number,
    mode: RuntimeSpawnOptions['mode'],
    private readonly onKill: (pid: number, signal?: NodeJS.Signals) => boolean,
  ) {
    super();
    this.stdin = mode === 'piped' ? new MockStdin() : null;
    this.stdout = mode === 'piped' ? (new PassThrough() as unknown as ChildReadableLike) : null;
    this.stderr = mode === 'piped' ? (new PassThrough() as unknown as ChildReadableLike) : null;
  }

  kill(signal?: NodeJS.Signals): boolean {
    return this.onKill(this.pid, signal);
  }

  unref(): void {}

  pushStdout(data: string): void {
    const readable = this.stdout as unknown as PassThrough | null;
    readable?.write(data);
  }

  pushStderr(data: string): void {
    const readable = this.stderr as unknown as PassThrough | null;
    readable?.write(data);
  }

  emitClose(code: number | null, signal: string | null): void {
    (this.stdout as unknown as PassThrough | null)?.end();
    (this.stderr as unknown as PassThrough | null)?.end();
    if (this.stdin instanceof MockStdin) {
      this.stdin.destroyed = true;
    }
    this.emit('close', code, signal as NodeJS.Signals | null);
  }

  emitFailure(error: Error): void {
    this.emit('error', error);
  }
}

export class MockDurableTransport implements DurableExecutionTransport {
  readonly launchCalls: DurableLaunchOptions[] = [];
  readonly waitForExitCalls: DurableLaunchResult[] = [];

  constructor(private readonly spawner: MockProcessSpawner) {}

  enqueue(script: MockDurableScript): void {
    this.spawner.enqueueDurable(script);
  }

  async launch(options: DurableLaunchOptions): Promise<DurableLaunchResult> {
    this.launchCalls.push({
      ...options,
      args: [...options.args],
      ...(options.envAdditions ? { envAdditions: { ...options.envAdditions } } : {}),
    });
    return this.spawner.launchDurable(options);
  }

  waitForExit(handle: DurableLaunchResult): Promise<DurableProcessExit> {
    this.waitForExitCalls.push(handle);
    return this.spawner.waitForDurableExit(handle);
  }
}

export class MockProcessSpawner {
  readonly spawnCalls: RuntimeSpawnOptions[] = [];
  readonly execSyncCalls: Array<{ command: string; args: string[]; options: RuntimeExecOptions }> = [];
  readonly killCalls: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];
  readonly durable: MockDurableTransport;
  private readonly processes = new Map<number, RegisteredProcess>();
  private readonly spawnScripts: MockSpawnScript[] = [];
  private readonly execSyncScripts: MockExecSyncScript[] = [];
  private readonly durableScripts: MockDurableScript[] = [];
  private nextPid = 20_000;

  constructor(
    private readonly time: VirtualTime,
    private readonly storage: InMemoryStorage,
    private readonly options: MockProcessSpawnerOptions,
  ) {
    this.durable = new MockDurableTransport(this);
  }

  enqueueSpawn(script: MockSpawnScript): void {
    this.spawnScripts.push(script);
  }

  enqueueDurable(script: MockDurableScript): void {
    this.durableScripts.push(script);
  }

  enqueueExecSync(script: MockExecSyncScript): void {
    this.execSyncScripts.push({
      command: script.command,
      args: [...script.args],
      result: { ...script.result },
    });
  }

  spawn(options: RuntimeSpawnOptions): ChildProcessLike {
    this.spawnCalls.push({
      ...options,
      args: [...options.args],
      ...(options.envAdditions ? { envAdditions: { ...options.envAdditions } } : {}),
    });

    const script = this.spawnScripts.shift() ?? {};
    const pid = script.pid ?? this.allocatePid();
    const child = new MockChildProcess(pid, options.mode, (childPid, signal) => this.killChild(childPid, signal));
    const record = this.registerProcess(pid, child, script.kills ?? [], null);
    attachSpawnRecordingMetadata(child, {
      command: options.command,
      args: options.args,
      env: options.envAdditions ? { ...options.envAdditions } : undefined,
    });

    script.onSpawn?.({
      child,
      schedule: (delayMs, fn) => {
        this.schedule(record, delayMs, fn);
      },
      close: (outcome) => {
        record.complete({
          exitCode: outcome?.code ?? 0,
          signal: outcome?.signal ?? null,
        });
      },
      fail: (error) => {
        if (record.closed) {
          return;
        }
        record.alive = false;
        child.emitFailure(toError(error));
      },
    });

    for (const chunk of asChunks(script.stdout)) {
      this.schedule(record, chunk.delayMs ?? 0, () => {
        if (!record.closed) {
          child.pushStdout(chunk.data);
        }
      });
    }
    for (const chunk of asChunks(script.stderr)) {
      this.schedule(record, chunk.delayMs ?? 0, () => {
        if (!record.closed) {
          child.pushStderr(chunk.data);
        }
      });
    }

    const scriptError = script.error;
    if (scriptError) {
      this.schedule(record, scriptError.delayMs ?? 0, () => {
        if (record.closed) {
          return;
        }
        record.alive = false;
        child.emitFailure(toError(scriptError.error));
      });
    }

    if (script.close !== null) {
      const close = script.close ?? { delayMs: 0, code: 0, signal: null };
      this.schedule(record, close.delayMs ?? 0, () => {
        record.complete({
          exitCode: close.code ?? 0,
          signal: close.signal ?? null,
        });
      });
    }

    return child;
  }

  execSync(command: string, args: string[], options: RuntimeExecOptions = {}): ExecResult {
    this.execSyncCalls.push({
      command,
      args: [...args],
      options: { ...options },
    });

    const script = this.execSyncScripts[0];
    if (!script) {
      throw new Error(`No execSync script enqueued for ${command} ${JSON.stringify(args)}`);
    }

    if (script.command !== command || !areArgsEqual(script.args, args)) {
      throw new Error(
        `Expected execSync ${script.command} ${JSON.stringify(script.args)} but received ${command} ${JSON.stringify(args)}`,
      );
    }

    this.execSyncScripts.shift();
    return { ...script.result };
  }

  kill(pid: number, signal: NodeJS.Signals | 0): void {
    this.killCalls.push({ pid, signal });
    if (signal === 0) {
      return;
    }
    const record = this.processes.get(pid);
    if (!record || record.closed) {
      return;
    }
    const action = this.resolveKillAction(record.killActions, signal);
    if (!action) {
      record.complete({
        exitCode: null,
        signal,
      });
      return;
    }
    this.schedule(record, action.delayMs ?? 0, () => {
      record.complete({
        exitCode: action.exitCode ?? null,
        signal: action.exitSignal ?? signal,
      });
    });
  }

  killChild(pid: number, signal?: NodeJS.Signals): boolean {
    const record = this.processes.get(pid);
    if (!record || record.closed) {
      return false;
    }
    this.kill(pid, signal ?? 'SIGTERM');
    return true;
  }

  isAlive(pid: number): boolean {
    return this.processes.get(pid)?.alive === true;
  }

  setAlive(pid: number, alive: boolean): void {
    const record = this.processes.get(pid);
    if (record) {
      record.alive = alive;
    }
  }

  async launchDurable(options: DurableLaunchOptions): Promise<DurableLaunchResult> {
    const script = this.durableScripts.shift() ?? {};
    const pid = script.pid ?? this.allocatePid();
    const stdoutPath = script.runtimeRecord?.stdoutPath ?? join(options.jobDir, 'stdout');
    const stderrPath = script.runtimeRecord?.stderrPath ?? join(options.jobDir, 'stderr');
    const envPath = join(options.jobDir, 'env.json');
    const runtimePath = join(options.jobDir, 'runtime.json');
    const exitPath = join(options.jobDir, 'exit.json');

    // Ensure scripted output paths stay within the job directory.
    // InMemoryStorage is entirely in-memory so this is a correctness concern,
    // not a security concern — a malicious scenario YAML could still only
    // overwrite other in-memory artifacts.
    const normalizedJobDir = normalize(options.jobDir) + '/';
    if (!normalize(stdoutPath).startsWith(normalizedJobDir)) {
      throw new Error(`stdoutPath "${stdoutPath}" escapes job directory "${options.jobDir}"`);
    }
    if (!normalize(stderrPath).startsWith(normalizedJobDir)) {
      throw new Error(`stderrPath "${stderrPath}" escapes job directory "${options.jobDir}"`);
    }

    this.storage.mkdirSync(options.jobDir, { recursive: true });
    this.storage.writeFileSync(stdoutPath, '');
    this.storage.writeFileSync(stderrPath, '');
    this.storage.writeAtomicSync(envPath, JSON.stringify(this.options.buildDurableEnv(options.envAdditions)), {
      encoding: 'utf-8',
    });

    const exitDeferred = createDeferred<DurableProcessExit>();
    const exitError = script.waitForExitError ? toError(script.waitForExitError) : null;
    const record = this.registerProcess(pid, null, script.kills ?? [], exitDeferred, (outcome) => {
      const exitRecord: DurableProcessExit = {
        exitCode: outcome.exitCode ?? null,
        signal: outcome.signal ?? null,
        endTime: nowIsoString(this.time),
      };
      this.storage.writeAtomicSync(exitPath, JSON.stringify(exitRecord, null, 2), { encoding: 'utf-8' });
      if (exitError) {
        exitDeferred.reject(exitError);
      } else {
        exitDeferred.resolve(exitRecord);
      }
    });

    for (const chunk of asChunks(script.stdout)) {
      this.schedule(record, chunk.delayMs ?? 0, () => {
        if (record.closed) {
          return;
        }
        this.storage.appendFileSync(stdoutPath, chunk.data);
      });
    }
    for (const chunk of asChunks(script.stderr)) {
      this.schedule(record, chunk.delayMs ?? 0, () => {
        if (record.closed) {
          return;
        }
        this.storage.appendFileSync(stderrPath, chunk.data);
      });
    }

    if ((script.runtimeDelayMs ?? 0) > 0) {
      await this.time.sleep(script.runtimeDelayMs ?? 0);
    }
    if (!record.alive && !this.storage.existsSync(exitPath)) {
      throw new Error(`Durable process ${pid} exited before runtime.json was written`);
    }

    const runtimeRecord: DurableCliRuntimeRecord = {
      ...script.runtimeRecord,
      startTime: script.runtimeRecord?.startTime ?? nowIsoString(this.time),
      pid,
      stdoutPath,
      stderrPath,
    };
    this.storage.writeAtomicSync(runtimePath, JSON.stringify(runtimeRecord, null, 2), { encoding: 'utf-8' });

    // Schedule exit AFTER runtime.json is persisted — mirrors production ordering
    // where the wrapper always writes runtime.json before exit.json
    if (script.exit !== null) {
      const exit = script.exit ?? { delayMs: 0, exitCode: 0, signal: null };
      this.schedule(record, exit.delayMs ?? 0, () => {
        record.complete({
          exitCode: exit.exitCode ?? 0,
          signal: exit.signal ?? null,
        });
      });
    }

    return {
      pid,
      stdoutPath,
      stderrPath,
      runtimeRecord,
    };
  }

  waitForDurableExit(handle: DurableLaunchResult): Promise<DurableProcessExit> {
    const record = this.processes.get(handle.pid);
    if (!record?.waitForExit) {
      return Promise.reject(new Error(`No durable process registered for pid ${handle.pid}`));
    }
    return record.waitForExit.promise;
  }

  private allocatePid(): number {
    const pid = this.nextPid;
    this.nextPid += 1;
    return pid;
  }

  private registerProcess(
    pid: number,
    child: MockChildProcess | null,
    killActions: MockKillAction[],
    waitForExit: Deferred<DurableProcessExit> | null,
    onExit?: (outcome: ProcessExitOutcome) => void,
  ): RegisteredProcess {
    const record: RegisteredProcess = {
      pid,
      alive: true,
      closed: false,
      timers: new Set(),
      child,
      killActions,
      waitForExit,
      complete: (outcome) => {
        if (record.closed) {
          return;
        }
        record.closed = true;
        record.alive = false;
        for (const timer of record.timers) {
          this.time.clearTimeout(timer);
        }
        record.timers.clear();
        onExit?.(outcome);
        if (child) {
          child.emitClose(outcome.exitCode ?? null, outcome.signal ?? null);
        }
      },
    };
    this.processes.set(pid, record);
    return record;
  }

  private schedule(record: RegisteredProcess, delayMs: number, fn: () => void): void {
    const timer = this.time.setTimeout(() => {
      record.timers.delete(timer);
      fn();
    }, delayMs);
    record.timers.add(timer);
  }

  private resolveKillAction(killActions: MockKillAction[], signal: NodeJS.Signals | 0): MockKillAction | null {
    return (
      killActions.find((entry) => entry.signal === signal) ??
      killActions.find((entry) => entry.signal === 'default') ??
      null
    );
  }
}

function areArgsEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
