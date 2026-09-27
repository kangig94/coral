import { spawn, type ChildProcess, type SendHandle } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createConnection, Server, Socket } from 'node:net';
import { constants as osConstants } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

import {
  readBoundedAdjacentManifest,
  strictBundleManifestSchema,
  type StrictBundleManifest,
} from '../infra/bundle-manifest.js';
import { createForeignTargetValidator } from '../infra/handoff-target.js';
import { socketPathForRunDir } from '../infra/path/index.js';
import { createPluginRegistry } from '../infra/plugin-registry.js';
import { compareProductVersions } from '../infra/product-version.js';
import { SENTINEL_TIMING, validSentinelTiming, type SentinelTiming } from '../infra/sentinel-timing.js';
import { probeProcessIncarnation } from '../infra/node-process.js';

export type SentinelMessage =
  | { kind: 'coral-sentinel-hello'; id: string }
  | { kind: 'coral-sentinel-armed'; id: string }
  | { kind: 'coral-sentinel-challenge'; id: number }
  | { kind: 'coral-sentinel-answer'; id: number }
  | { kind: 'coral-sentinel-child'; pid: number }
  | { kind: 'coral-sentinel-retire-child' }
  | { kind: 'coral-sentinel-upstream-disconnected' };

function sentinelMessage(value: unknown): value is SentinelMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    typeof value.kind === 'string' &&
    value.kind.startsWith('coral-sentinel-')
  );
}

function childIsUninterruptible(pid: number): boolean {
  if (process.platform !== 'linux') return false;
  try {
    // The command name is parenthesized and may contain spaces or ')' itself.
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat[stat.lastIndexOf(')') + 2] === 'D';
  } catch {
    return false;
  }
}

function closeRelayedHandle(handle: unknown): void {
  if (handle instanceof Server) handle.close();
  else if (handle instanceof Socket) handle.destroy();
}

function writeSentinelRecord(runDir: string | undefined, id: string, record: Readonly<Record<string, unknown>>): void {
  if (runDir === undefined || !isAbsolute(runDir)) return;
  const directory = join(runDir, 'coordinator-sentinel.v1');
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${id}.json`);
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } catch (error: unknown) {
    process.stderr.write(`Coordinator sentinel could not record ${String(record.state)}: ${String(error)}\n`);
  }
}

function validatedBuild(root: string): StrictBundleManifest | null {
  const bundleDir = join(root, 'bridge');
  const adjacent = readBoundedAdjacentManifest(bundleDir);
  if (!adjacent.ok) return null;
  const parsed = strictBundleManifestSchema.safeParse(adjacent.value);
  if (!parsed.success || createForeignTargetValidator()(bundleDir, parsed.data).kind !== 'validated') return null;
  if (!existsSync(join(bundleDir, 'coral-sentinel.cjs')) || !existsSync(join(bundleDir, 'coral-backend.cjs')))
    return null;
  return parsed.data;
}

function relaunchRoots(runDir: string, original: StrictBundleManifest | null): string[] {
  let installedRoots: string[];
  try {
    installedRoots = createPluginRegistry().installedPluginRoots('coral');
  } catch {
    installedRoots = [];
  }
  const installed = installedRoots
    .map((root) => ({ root, manifest: validatedBuild(root) }))
    .filter((entry): entry is { root: string; manifest: StrictBundleManifest } => entry.manifest !== null)
    .filter((entry) => original === null || entry.manifest.flavor === original.flavor)
    .sort((a, b) => compareProductVersions(b.manifest.version, a.manifest.version))
    .map((entry) => entry.root);
  if (original !== null) {
    const retained = join(dirname(runDir), 'builds', original.buildSetId);
    if (
      validatedBuild(retained) !== null &&
      createForeignTargetValidator()(join(retained, 'bridge'), original).kind === 'validated'
    )
      installed.push(retained);
  }
  return [...new Set(installed)];
}

async function replacementServing(
  runDir: string,
  flavor: StrictBundleManifest['flavor'],
  pid: number,
): Promise<boolean> {
  try {
    const discovery = JSON.parse(readFileSync(join(runDir, 'coordinator.json'), 'utf8')) as {
      pid?: unknown;
      bootToken?: unknown;
    };
    if (discovery.pid !== pid) return false;
    if (typeof discovery.bootToken !== 'string') return false;
    const socketPath = socketPathForRunDir(runDir, flavor, { platform: process.platform });
    return await new Promise<boolean>((resolve) => {
      const socket = createConnection(socketPath);
      let received = '';
      let settled = false;
      const finish = (serving: boolean): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(serving);
      };
      socket.setTimeout(500, () => finish(false));
      socket.once('error', () => finish(false));
      socket.once('close', () => finish(false));
      socket.once('connect', () => {
        socket.write(
          `${JSON.stringify({ kind: 'request', id: 1, method: 'transport.health', auth: { kind: 'boot', token: discovery.bootToken } })}\n`,
        );
      });
      socket.on('data', (chunk: Buffer) => {
        received += chunk.toString('utf8');
        if (received.length > 64 * 1024) return finish(false);
        const newline = received.indexOf('\n');
        if (newline === -1) return;
        try {
          const response = JSON.parse(received.slice(0, newline)) as {
            kind?: string;
            id?: number;
            result?: { pid?: number; status?: string };
          };
          finish(
            response.kind === 'response' &&
              response.id === 1 &&
              response.result?.pid === pid &&
              (response.result.status === 'ok' || response.result.status === 'running'),
          );
        } catch {
          finish(false);
        }
      });
    });
  } catch {
    return false;
  }
}

/** The parent-held ChildProcess is the only signal authority for this incarnation. */
export async function runCoordinatorSentinel(
  executable: string,
  args: readonly string[],
  options: Readonly<{
    timing?: SentinelTiming;
    onChild?: (child: ChildProcess) => void;
    fixtureRelaunch?: boolean;
  }> = {},
): Promise<number> {
  const timing = options.timing ?? SENTINEL_TIMING;
  if (!validSentinelTiming(timing)) throw new Error('Invalid coordinator sentinel timing');
  const id = randomUUID();
  const startedAt = Date.now();
  const runDir = process.env.CORAL_SENTINEL_RUN_DIR;
  const originalManifest = validatedBuild(dirname(dirname(executable)));
  let coordinatorIdentity: { coordinatorPid: number; coordinatorIncarnation: string | null } | null = null;
  const record = (state: string, fields: Record<string, unknown> = {}): void => {
    writeSentinelRecord(runDir, id, {
      version: 1,
      sentinelId: id,
      sentinelPid: process.pid,
      sentinelIncarnation: probeProcessIncarnation(process.pid),
      attemptId: process.env.CORAL_STARTUP_ATTEMPT_ID,
      spawnNonce: process.env.CORAL_WAITER_SPAWN_NONCE,
      ...coordinatorIdentity,
      executable,
      startedAt,
      timing,
      state,
      ...fields,
    });
  };
  record('prepared');
  const child = spawn(process.execPath, [executable, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, CORAL_SENTINEL_ID: id },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  if (child.pid !== undefined) {
    coordinatorIdentity = {
      coordinatorPid: child.pid,
      coordinatorIncarnation: probeProcessIncarnation(child.pid),
    };
  }
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  let armed = false;
  let helloPending = false;
  const acknowledgeArm = (): void => {
    if (!armed || !helloPending || !child.connected) return;
    helloPending = false;
    child.send({ kind: 'coral-sentinel-armed', id } satisfies SentinelMessage);
  };
  child.on('message', (message: unknown) => {
    if (sentinelMessage(message) && message.kind === 'coral-sentinel-hello' && message.id === id) {
      helloPending = true;
      acknowledgeArm();
    }
  });
  options.onChild?.(child);
  const spawned = await new Promise<boolean>((resolve) => {
    child.once('spawn', () => resolve(true));
    child.once('error', () => resolve(false));
  });
  if (!spawned || child.pid === undefined) return 1;
  if (coordinatorIdentity?.coordinatorIncarnation === null) {
    coordinatorIdentity.coordinatorIncarnation = probeProcessIncarnation(child.pid);
  }
  record('armed', { coordinatorPid: child.pid });
  armed = true;
  acknowledgeArm();
  process.send?.({ kind: 'coral-sentinel-child', pid: child.pid } satisfies SentinelMessage);

  let lastWake = Date.now();
  let lastAnswer = lastWake;
  let outstanding: number | null = null;
  let sequence = 0;
  let escalationAt: number | null = null;
  let killed = false;
  let channelAvailable = true;
  let schedulingGaps = 0;
  let wedgeTermination = false;
  const reset = (now: number): void => {
    lastAnswer = now;
    outstanding = null;
    escalationAt = null;
    killed = false;
  };
  const tick = (): void => {
    const now = Date.now();
    if (now - lastWake > timing.schedulingGapMs) {
      schedulingGaps += 1;
      reset(now);
    }
    lastWake = now;
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (escalationAt !== null) {
      if (!killed && now - escalationAt >= timing.graceMs) {
        if (child.pid !== undefined && childIsUninterruptible(child.pid)) reset(now);
        else {
          record('killing', { coordinatorPid: child.pid, lastAnswer, schedulingGaps });
          child.kill('SIGKILL');
          killed = true;
        }
      }
      return;
    }
    if (now - lastAnswer >= timing.lapseMs) {
      if (child.pid !== undefined && childIsUninterruptible(child.pid)) reset(now);
      else {
        record('terminating', { coordinatorPid: child.pid, lastAnswer, schedulingGaps });
        wedgeTermination = child.kill('SIGTERM') || wedgeTermination;
        escalationAt = now;
      }
      return;
    }
    if (channelAvailable && outstanding === null) {
      outstanding = ++sequence;
      child.send({ kind: 'coral-sentinel-challenge', id: outstanding } satisfies SentinelMessage, (error) => {
        if (error) channelAvailable = false;
      });
    }
  };
  const interval = setInterval(tick, timing.challengeMs);
  tick();
  child.on('message', (message: unknown, handle: unknown) => {
    if (sentinelMessage(message)) {
      if (message.kind === 'coral-sentinel-answer' && message.id === outstanding) {
        lastAnswer = Date.now();
        outstanding = null;
        escalationAt = null;
        killed = false;
      }
      return;
    }
    if (process.connected) {
      process.send?.(message as Parameters<NonNullable<typeof process.send>>[0], handle as SendHandle, () => {
        closeRelayedHandle(handle);
      });
    } else closeRelayedHandle(handle);
  });
  child.on('disconnect', () => {
    channelAvailable = false;
  });
  process.on('message', (message: unknown, handle: unknown) => {
    if (sentinelMessage(message)) {
      if (
        message.kind === 'coral-sentinel-retire-child' &&
        escalationAt === null &&
        child.exitCode === null &&
        child.signalCode === null
      ) {
        const now = Date.now();
        record('terminating', { coordinatorPid: child.pid, lastAnswer, schedulingGaps, reason: 'succession-attempt' });
        child.kill('SIGTERM');
        escalationAt = now;
      }
      return;
    }
    if (child.connected) {
      child.send(message as Parameters<typeof child.send>[0], handle as SendHandle, () => {
        closeRelayedHandle(handle);
      });
    } else closeRelayedHandle(handle);
  });
  process.on('disconnect', () => {
    if (child.connected) child.send({ kind: 'coral-sentinel-upstream-disconnected' } satisfies SentinelMessage);
  });
  return exited.then(async ({ code, signal }) => {
    clearInterval(interval);
    const exitCode = code ?? (signal === null ? 1 : 128 + osConstants.signals[signal]);
    record('exited', {
      coordinatorPid: child.pid,
      exitCode,
      childExitCode: code,
      childSignal: signal,
      lastAnswer,
      schedulingGaps,
      cleanup: 'retained-for-startup-reclamation',
    });
    if (child.connected) child.disconnect();
    if (process.connected) process.disconnect();
    if (wedgeTermination && runDir !== undefined && isAbsolute(runDir) && process.argv[1] !== undefined) {
      await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
      const recoveryEnv = { ...process.env };
      delete recoveryEnv.CORAL_STARTUP_ATTEMPT_ID;
      delete recoveryEnv.CORAL_WAITER_LAUNCHED;
      delete recoveryEnv.CORAL_WAITER_SPAWN_NONCE;
      delete recoveryEnv.CORAL_STARTUP_STARTED_AT;
      delete recoveryEnv.CORAL_SUCCESSION_ATTEMPT_ID;
      const roots = relaunchRoots(runDir, originalManifest);
      const candidates: { sentinel: string; backend: string; manifest: StrictBundleManifest | null }[] = roots.flatMap(
        (root) => {
          const manifest = validatedBuild(root);
          return manifest === null
            ? []
            : [
                {
                  sentinel: join(root, 'bridge', 'coral-sentinel.cjs'),
                  backend: join(root, 'bridge', 'coral-backend.cjs'),
                  manifest,
                },
              ];
        },
      );
      if (options.fixtureRelaunch && existsSync(process.argv[1]) && existsSync(executable)) {
        candidates.push({ sentinel: process.argv[1], backend: executable, manifest: null });
      }
      if (candidates.length === 0)
        record('relaunch-unavailable', { reason: 'no validated installed or retained build' });
      for (let attempt = 0; attempt < 3 && candidates.length > 0; attempt += 1) {
        const candidate = candidates[attempt % candidates.length];
        if (candidate === undefined) break;
        if (!existsSync(candidate.sentinel) || !existsSync(candidate.backend)) continue;
        if (candidate.manifest !== null && validatedBuild(dirname(dirname(candidate.backend))) === null) continue;
        const replacement = spawn(process.execPath, [candidate.sentinel, candidate.backend, ...args], {
          cwd: process.cwd(),
          detached: true,
          env: recoveryEnv,
          stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        });
        let childPid: number | null = null;
        let fixtureReady = false;
        let spawnError: Error | null = null;
        replacement.once('error', (error) => {
          spawnError = error;
        });
        replacement.on('message', (message: unknown) => {
          if (typeof message !== 'object' || message === null || !('kind' in message)) return;
          if (message.kind === 'coral-sentinel-child' && 'pid' in message && typeof message.pid === 'number')
            childPid = message.pid;
          if (message.kind === 'ready') fixtureReady = true;
        });
        const deadline = Date.now() + 15_000;
        while (
          Date.now() < deadline &&
          replacement.exitCode === null &&
          replacement.signalCode === null &&
          spawnError === null
        ) {
          if (
            childPid !== null &&
            (candidate.manifest === null
              ? fixtureReady
              : await replacementServing(runDir, candidate.manifest.flavor, childPid))
          ) {
            record('relaunched', {
              replacementSentinelPid: replacement.pid,
              coordinatorPid: childPid,
              root: dirname(dirname(candidate.backend)),
            });
            replacement.disconnect();
            replacement.unref();
            return exitCode;
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 200));
        }
        if (spawnError === null && replacement.exitCode === null && replacement.signalCode === null) {
          record('relaunch-unconfirmed', {
            replacementSentinelPid: replacement.pid,
            root: dirname(dirname(candidate.backend)),
          });
          replacement.disconnect();
          replacement.unref();
          return exitCode;
        }
        record('relaunch-failed', {
          root: dirname(dirname(candidate.backend)),
          childExitCode: replacement.exitCode,
          ...(spawnError === null ? {} : { error: String(spawnError) }),
        });
        await new Promise<void>((resolve) => setTimeout(resolve, 200));
      }
      if (candidates.length > 0) record('relaunch-unavailable', { reason: 'all bounded attempts failed' });
    }
    return exitCode;
  });
}
