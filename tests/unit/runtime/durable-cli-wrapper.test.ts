import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';

const createdDirs: string[] = [];

afterEach(() => {
  for (const dir of createdDirs.splice(0, createdDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'coral-durable-wrapper-'));
  createdDirs.push(dir);
  return dir;
}

async function waitForFile(path: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForLineCount(path: string, count: number, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path) || readFileSync(path, 'utf8').trimEnd().split('\n').length < count) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${count} lines in ${path}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

type FinalizerOutcome = 'error' | 'error-then-signal' | 'close' | 'ready';

type WrapperHarness = Readonly<{
  attemptLogPath: string;
  closePromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  descendantSignalPath: string;
  retryTriggerPath: string;
  stderr: () => string;
  wrapper: ReturnType<typeof spawn>;
  cleanup: () => Promise<void>;
}>;

type ContainedDescendantOptions = Readonly<{
  ignoreSigterm?: boolean;
  terminationGraceMs?: number;
}>;

async function buildWrapperWithFinalizerOutcomes(
  wrapperPath: string,
  attemptLogPath: string,
  retryTriggerPath: string,
  outcomes: readonly FinalizerOutcome[],
  terminationGraceMs: number,
): Promise<void> {
  await build({
    entryPoints: [fileURLToPath(new URL('../../../src/runtime/durable-cli-wrapper.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: wrapperPath,
    plugins: [
      {
        name: 'group-finalizer-scenario',
        setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /^node:child_process$/, namespace: 'file' }, () => ({
            path: 'group-finalizer-scenario',
            namespace: 'group-finalizer-scenario',
          }));
          pluginBuild.onResolve({ filter: /process-supervision\.js$/, namespace: 'file' }, () => ({
            path: 'process-supervision-scenario',
            namespace: 'process-supervision-scenario',
          }));
          pluginBuild.onLoad({ filter: /.*/, namespace: 'group-finalizer-scenario' }, () => ({
            loader: 'js',
            contents: `
              import { execFile, execFileSync, spawn as realSpawn } from 'node:child_process';
              import { EventEmitter } from 'node:events';
              import { appendFileSync } from 'node:fs';
              export { execFile, execFileSync };
              const outcomes = ${JSON.stringify(outcomes)};
              let finalizerAttempt = 0;
              export const spawn = (command, args, options) => {
                if (args?.[1] !== '--finalize-group') return realSpawn(command, args, options);
                const outcome = outcomes[finalizerAttempt] ?? outcomes.at(-1) ?? 'ready';
                finalizerAttempt += 1;
                appendFileSync(${JSON.stringify(attemptLogPath)}, outcome + '\\n');
                const child = new EventEmitter();
                child.connected = false;
                child.channel = { unref() {} };
                child.send = () => false;
                child.unref = () => child;
                queueMicrotask(() => {
                  if (outcome === 'error' || outcome === 'error-then-signal') {
                    const error = Object.assign(new Error('spawn EAGAIN'), { code: 'EAGAIN' });
                    child.emit('error', error);
                    child.emit('close', -2, null);
                    if (outcome === 'error-then-signal') {
                      process.emit('SIGINT');
                      appendFileSync(${JSON.stringify(retryTriggerPath)}, String(finalizerAttempt));
                    }
                    return;
                  }
                  if (outcome === 'close') {
                    child.emit('exit', 1, null);
                    child.emit('close', 1, null);
                    return;
                  }
                  child.emit('message', 'ready');
                });
                return child;
              };
            `,
          }));
          pluginBuild.onLoad({ filter: /.*/, namespace: 'process-supervision-scenario' }, () => ({
            loader: 'js',
            contents: `
              export const gracefulKill = (child, runtime, observeLiveness) => {
                let delivered;
                try {
                  delivered = child.kill('SIGTERM');
                } catch {
                  return { kind: 'signal-failed', pid: child.pid ?? null, signal: 'SIGTERM', reason: 'kill-port-threw' };
                }
                if (delivered === false) {
                  return {
                    kind: 'signal-failed',
                    pid: child.pid ?? null,
                    signal: 'SIGTERM',
                    reason: 'kill-port-returned-false',
                  };
                }
                if (child.pid === undefined) return { kind: 'signal-refused', pid: null, reason: 'child-pid-unavailable' };

                const pid = child.pid;
                const settlement = new Promise((resolve) => {
                  let settled = false;
                  const finish = (outcome) => {
                    if (settled) return;
                    settled = true;
                    runtime.time.clearTimeout(timer);
                    resolve(outcome);
                  };
                  const timer = runtime.time.setTimeout(() => {
                    const observation = observeLiveness(pid);
                    if (observation === 'absent') {
                      finish({ kind: 'observed-absent', pid });
                      return;
                    }
                    if (observation !== 'alive') {
                      finish({ kind: 'target-unobservable', pid, stage: 'after-sigterm' });
                      return;
                    }
                    child.kill('SIGKILL');
                  }, ${JSON.stringify(terminationGraceMs)});
                  timer.unref?.();
                  child.on('close', () => finish({ kind: 'observed-absent', pid }));
                });
                return { kind: 'escalation-scheduled', pid, settlement };
              };
            `,
          }));
        },
      },
    ],
  });
}

async function startWrapperWithContainedDescendant(
  outcomes: readonly FinalizerOutcome[],
  options: ContainedDescendantOptions = {},
): Promise<WrapperHarness> {
  const rootDir = createTempDir();
  const jobDir = join(rootDir, 'job');
  const wrapperPath = join(rootDir, 'durable-cli-wrapper.mjs');
  const attemptLogPath = join(rootDir, 'finalizer-attempts');
  const retryTriggerPath = join(rootDir, 'retry-trigger');
  const descendantStartedPath = join(rootDir, 'descendant-started');
  const descendantSignalPath = join(rootDir, 'descendant-signal');
  const launchPayloadPath = join(jobDir, 'launch.v1.json');
  mkdirSync(jobDir);
  writeFileSync(join(jobDir, 'env.json'), '{}');
  await buildWrapperWithFinalizerOutcomes(
    wrapperPath,
    attemptLogPath,
    retryTriggerPath,
    outcomes,
    options.terminationGraceMs ?? 5_000,
  );

  const descendantScript = [
    `const fs = require('node:fs')`,
    `process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(descendantSignalPath)}, 'observed'); ${options.ignoreSigterm === true ? '' : 'process.exit(0);'} })`,
    `fs.writeFileSync(${JSON.stringify(descendantStartedPath)}, 'started')`,
    `setInterval(() => {}, 1000)`,
  ].join(';');
  const providerScript = [
    `const { spawn } = require('node:child_process')`,
    `const fs = require('node:fs')`,
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { stdio: 'ignore' })`,
    `child.unref()`,
    `const poll = setInterval(() => { if (!fs.existsSync(${JSON.stringify(descendantStartedPath)})) return; clearInterval(poll); process.exit(0); }, 5)`,
  ].join(';');
  writeFileSync(
    launchPayloadPath,
    JSON.stringify({
      version: 1,
      command: process.execPath,
      args: ['-e', providerScript],
      cwd: null,
      prompt: '',
      startTime: new Date().toISOString(),
    }),
  );

  const wrapper = spawn(process.execPath, [wrapperPath, launchPayloadPath], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let closed = false;
  let stderr = '';
  wrapper.stdout?.resume();
  wrapper.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const closePromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    wrapper.once('error', reject);
    wrapper.once('close', (code, signal) => {
      closed = true;
      resolve({ code, signal });
    });
  });
  wrapper.send('runtime-start-published');
  await waitForFile(descendantStartedPath);

  return {
    attemptLogPath,
    closePromise,
    descendantSignalPath,
    retryTriggerPath,
    stderr: () => stderr,
    wrapper,
    cleanup: async () => {
      if (closed || wrapper.pid === undefined) return;
      try {
        process.kill(-wrapper.pid, 'SIGKILL');
      } catch {
        return;
      }
      await closePromise;
    },
  };
}

function finalizerAttempts(path: string): string[] {
  return readFileSync(path, 'utf8').trimEnd().split('\n');
}

describe('durable-cli-wrapper', () => {
  it('retries a finalizer spawn error and terminates the contained group', async () => {
    const harness = await startWrapperWithContainedDescendant(['error', 'ready']);
    try {
      expect(harness.wrapper.kill('SIGTERM')).toBe(true);
      await waitForFile(harness.descendantSignalPath, 5_000);
      expect(await harness.closePromise).toEqual({ code: 0, signal: null });
      expect(finalizerAttempts(harness.attemptLogPath)).toEqual(['error', 'ready']);
      expect(harness.stderr()).toBe('');
    } finally {
      await harness.cleanup();
    }
  });

  it('retries a finalizer that closes before accepting the handoff', async () => {
    const harness = await startWrapperWithContainedDescendant(['close', 'ready']);
    try {
      expect(harness.wrapper.kill('SIGTERM')).toBe(true);
      await waitForFile(harness.descendantSignalPath, 5_000);
      expect(await harness.closePromise).toEqual({ code: 0, signal: null });
      expect(finalizerAttempts(harness.attemptLogPath)).toEqual(['close', 'ready']);
    } finally {
      await harness.cleanup();
    }
  });

  it('lets a later signal re-drive a failed finalizer handoff', async () => {
    const harness = await startWrapperWithContainedDescendant(['error-then-signal', 'ready']);
    try {
      expect(harness.wrapper.kill('SIGTERM')).toBe(true);
      await waitForFile(harness.retryTriggerPath);
      expect(readFileSync(harness.retryTriggerPath, 'utf8')).toBe('2');
      await waitForFile(harness.descendantSignalPath, 5_000);
      expect(await harness.closePromise).toEqual({ code: 0, signal: null });
      expect(finalizerAttempts(harness.attemptLogPath)).toEqual(['error-then-signal', 'ready']);
    } finally {
      await harness.cleanup();
    }
  });

  it('does not retry a finalizer after it accepts the handoff', async () => {
    const harness = await startWrapperWithContainedDescendant(['ready', 'error']);
    try {
      expect(harness.wrapper.kill('SIGTERM')).toBe(true);
      await waitForFile(harness.descendantSignalPath, 5_000);
      expect(await harness.closePromise).toEqual({ code: 0, signal: null });
      expect(finalizerAttempts(harness.attemptLogPath)).toEqual(['ready']);
    } finally {
      await harness.cleanup();
    }
  });

  it('escalates a SIGTERM-resistant group after finalizer retries are exhausted', async () => {
    const harness = await startWrapperWithContainedDescendant(['error'], {
      ignoreSigterm: true,
      terminationGraceMs: 100,
    });
    try {
      expect(harness.wrapper.kill('SIGTERM')).toBe(true);
      await waitForLineCount(harness.attemptLogPath, 1);
      for (const [attempt, signal] of [
        [2, 'SIGINT'],
        [3, 'SIGHUP'],
        [4, 'SIGINT'],
      ] as const) {
        expect(harness.wrapper.kill(signal)).toBe(true);
        await waitForLineCount(harness.attemptLogPath, attempt);
      }

      await waitForFile(harness.descendantSignalPath);
      expect(await harness.closePromise).toEqual({ code: null, signal: 'SIGKILL' });
      expect(finalizerAttempts(harness.attemptLogPath).length).toBeGreaterThanOrEqual(5);
    } finally {
      await harness.cleanup();
    }
  });

  it('does not spawn a provider after termination wins the publication gate', async () => {
    const rootDir = createTempDir();
    const jobDir = join(rootDir, 'job');
    const wrapperPath = join(rootDir, 'durable-cli-wrapper.mjs');
    const spawnLogPath = join(rootDir, 'spawn-log');
    const providerStartedPath = join(rootDir, 'provider-started');
    const launchPayloadPath = join(jobDir, 'launch.v1.json');
    mkdirSync(jobDir);
    writeFileSync(join(jobDir, 'env.json'), '{}');

    await build({
      entryPoints: [fileURLToPath(new URL('../../../src/runtime/durable-cli-wrapper.ts', import.meta.url))],
      bundle: true,
      format: 'esm',
      platform: 'node',
      outfile: wrapperPath,
      plugins: [
        {
          name: 'spawn-observer',
          setup(pluginBuild) {
            pluginBuild.onResolve({ filter: /^node:child_process$/, namespace: 'file' }, () => ({
              path: 'spawn-observer',
              namespace: 'spawn-observer',
            }));
            pluginBuild.onLoad({ filter: /.*/, namespace: 'spawn-observer' }, () => ({
              loader: 'js',
              contents: `
                import { execFile, execFileSync, spawn as realSpawn } from 'node:child_process';
                import { appendFileSync } from 'node:fs';
                export { execFile, execFileSync };
                export const spawn = (...args) => {
                  appendFileSync(${JSON.stringify(spawnLogPath)}, JSON.stringify(args.slice(0, 2)) + '\\n');
                  return realSpawn(...args);
                };
              `,
            }));
          },
        },
      ],
    });

    writeFileSync(
      launchPayloadPath,
      JSON.stringify({
        version: 1,
        command: process.execPath,
        args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(providerStartedPath)}, 'started')`],
        cwd: null,
        prompt: '',
        startTime: new Date().toISOString(),
      }),
    );
    const wrapper = spawn(process.execPath, [wrapperPath, launchPayloadPath], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const closePromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      wrapper.once('error', reject);
      wrapper.once('close', (code, signal) => resolve({ code, signal }));
    });
    wrapper.stdout?.resume();
    wrapper.stderr?.resume();

    await waitForFile(join(jobDir, 'stderr'));
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(wrapper.kill('SIGTERM')).toBe(true);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    if (wrapper.connected) wrapper.send('runtime-start-published', () => undefined);

    const close = await closePromise;

    expect(close).toEqual({ code: 0, signal: null });
    expect(existsSync(spawnLogPath)).toBe(false);
    expect(existsSync(providerStartedPath)).toBe(false);
  });

  it('reports ordinary completion when a provider closes stdin before receiving the prompt', async () => {
    const rootDir = createTempDir();
    const jobDir = join(rootDir, 'job');
    const wrapperPath = join(rootDir, 'durable-cli-wrapper.mjs');
    const launchPayloadPath = join(jobDir, 'launch.v1.json');
    mkdirSync(jobDir);
    writeFileSync(join(jobDir, 'env.json'), '{}');

    await build({
      entryPoints: [fileURLToPath(new URL('../../../src/runtime/durable-cli-wrapper.ts', import.meta.url))],
      bundle: true,
      format: 'esm',
      platform: 'node',
      outfile: wrapperPath,
      plugins: [
        {
          name: 'closed-provider-stdin',
          setup(pluginBuild) {
            pluginBuild.onResolve({ filter: /^node:child_process$/, namespace: 'file' }, () => ({
              path: 'closed-provider-stdin',
              namespace: 'closed-provider-stdin',
            }));
            pluginBuild.onLoad({ filter: /.*/, namespace: 'closed-provider-stdin' }, () => ({
              loader: 'js',
              contents: `
                import { execFile, execFileSync, spawn as realSpawn } from 'node:child_process';
                import { EventEmitter } from 'node:events';
                export { execFile, execFileSync };
                export const spawn = (command, args, options) => {
                  if (command !== 'provider-closes-stdin') return realSpawn(command, args, options);
                  const child = new EventEmitter();
                  const childStdin = new EventEmitter();
                  child.pid = process.pid;
                  child.stdin = childStdin;
                  childStdin.destroyed = true;
                  childStdin.write = () => {
                    queueMicrotask(() => {
                      childStdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
                      child.emit('close', 0, null);
                    });
                    return false;
                  };
                  childStdin.end = () => undefined;
                  return child;
                };
              `,
            }));
          },
        },
      ],
    });

    writeFileSync(
      launchPayloadPath,
      JSON.stringify({
        version: 1,
        command: 'provider-closes-stdin',
        args: [],
        cwd: null,
        prompt: 'non-empty prompt',
        startTime: new Date().toISOString(),
      }),
    );
    const wrapper = spawn(process.execPath, [wrapperPath, launchPayloadPath], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const stdout = wrapper.stdout;
    const stderr = wrapper.stderr;
    if (stdout === null || stderr === null) throw new Error('Expected wrapper control pipes');

    let controlOutput = '';
    let errorOutput = '';
    stdout.on('data', (chunk: Buffer) => {
      controlOutput += chunk.toString();
    });
    stderr.on('data', (chunk: Buffer) => {
      errorOutput += chunk.toString();
    });
    wrapper.send('runtime-start-published');

    const close = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      wrapper.once('error', reject);
      wrapper.once('close', (code, signal) => resolve({ code, signal }));
    });
    const records = controlOutput
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string });

    expect(close).toEqual({ code: 0, signal: null });
    expect(errorOutput).toBe('');
    expect(records.map((record) => record.type)).toEqual(['runtime', 'exit']);
    expect(records.at(-1)).toMatchObject({
      type: 'exit',
      exitRecord: { exitCode: 0, signal: null, endTime: expect.any(String) },
    });
  });

  it('flushes its complete exit record while its stdout reader is paused', async () => {
    const rootDir = createTempDir();
    const jobDir = join(rootDir, 'job');
    const wrapperPath = join(rootDir, 'durable-cli-wrapper.mjs');
    const childExitedPath = join(rootDir, 'child-exited');
    const launchPayloadPath = join(jobDir, 'launch.v1.json');
    mkdirSync(jobDir);
    writeFileSync(join(jobDir, 'env.json'), '{}');

    await build({
      entryPoints: [fileURLToPath(new URL('../../../src/runtime/durable-cli-wrapper.ts', import.meta.url))],
      bundle: true,
      format: 'esm',
      platform: 'node',
      outfile: wrapperPath,
    });

    const childScript = `require('node:fs').writeFileSync(${JSON.stringify(childExitedPath)}, 'done')`;
    writeFileSync(
      launchPayloadPath,
      JSON.stringify({
        version: 1,
        command: process.execPath,
        args: ['-e', childScript],
        cwd: null,
        prompt: '',
        startTime: '\u0001'.repeat(120_000),
      }),
    );
    const wrapper = spawn(process.execPath, [wrapperPath, launchPayloadPath], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const stdout = wrapper.stdout;
    const stderr = wrapper.stderr;
    if (stdout === null || stderr === null) throw new Error('Expected wrapper control pipes');

    let exited = false;
    wrapper.once('exit', () => {
      exited = true;
    });
    stdout.pause();
    wrapper.send('runtime-start-published');

    try {
      await waitForFile(childExitedPath, 5_000);
      expect(existsSync(launchPayloadPath)).toBe(false);
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      expect(exited).toBe(false);

      let controlOutput = '';
      let errorOutput = '';
      stdout.on('data', (chunk: Buffer) => {
        controlOutput += chunk.toString();
      });
      stderr.on('data', (chunk: Buffer) => {
        errorOutput += chunk.toString();
      });
      stdout.resume();

      const close = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        wrapper.once('error', reject);
        wrapper.once('close', (code, signal) => resolve({ code, signal }));
      });
      const records = controlOutput
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line) as { type: string });

      expect(close).toEqual({ code: 0, signal: null });
      expect(errorOutput).toBe('');
      expect(records.map((record) => record.type)).toEqual(['runtime', 'exit']);
      expect(records.at(-1)).toMatchObject({
        type: 'exit',
        exitRecord: { exitCode: 0, signal: null, endTime: expect.any(String) },
      });
    } finally {
      if (!exited) {
        wrapper.kill('SIGKILL');
        await new Promise<void>((resolve) => wrapper.once('close', () => resolve()));
      }
    }
  });
});
