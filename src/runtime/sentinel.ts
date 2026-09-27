import { spawn, type ChildProcess, type SendHandle } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
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
import { probeProcessIncarnation, processIncarnationSchema, type ProcessIncarnation } from '../infra/node-process.js';
import { readUpgradeIntent, retryUpgradeIntentCas } from '../infra/upgrade-intent.js';

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

function writeSentinelRecord(
  runDir: string | undefined,
  id: string,
  record: Readonly<Record<string, unknown>>,
): boolean {
  if (runDir === undefined || !isAbsolute(runDir)) return false;
  const directory = join(runDir, 'coordinator-sentinel.v1');
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${id}.json`);
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    const file = openSync(temporary, 'r');
    try {
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(temporary, path);
    const parent = openSync(directory, 'r');
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
    const runDirectory = openSync(runDir, 'r');
    try {
      fsyncSync(runDirectory);
    } finally {
      closeSync(runDirectory);
    }
    return true;
  } catch (error: unknown) {
    process.stderr.write(`Coordinator sentinel could not record ${String(record.state)}: ${String(error)}\n`);
    return false;
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

function waiterAttemptDisposition(
  runDir: string,
  attemptId: string,
  spawnNonce: string,
  originalPid: number,
  originalIncarnation: ProcessIncarnation,
  build: StrictBundleManifest | null,
): 'attempting' | 'completed' | null {
  const observed = readUpgradeIntent(runDir);
  if (observed.kind !== 'readable') return null;
  const intent = observed.intent;
  if (
    intent.attemptId !== attemptId ||
    intent.attemptSpawnNonce !== spawnNonce ||
    intent.attemptOwner?.kind !== 'waiter' ||
    (build !== null &&
      (intent.target.build.buildSetId !== build.buildSetId || intent.target.build.bundleHash !== build.bundleHash))
  )
    return null;
  if (intent.disposition === 'completed') {
    const receipt = intent.completionReceipt;
    return receipt?.kind === 'serving' &&
      receipt.attemptId === attemptId &&
      receipt.successor.pid === originalPid &&
      receipt.successor.incarnation === originalIncarnation
      ? 'completed'
      : null;
  }
  return intent.disposition === 'attempting' &&
    (intent.attemptDeadline === null || Date.now() < Date.parse(intent.attemptDeadline)) &&
    (intent.attemptChild === null ||
      intent.attemptChild === undefined ||
      (intent.attemptChild.attemptId === attemptId &&
        intent.attemptChild.pid === originalPid &&
        intent.attemptChild.incarnation === originalIncarnation))
    ? 'attempting'
    : null;
}

async function rebindWaiterAttempt(
  runDir: string,
  attemptId: string,
  spawnNonce: string,
  originalPid: number,
  originalIncarnation: ProcessIncarnation,
  replacementPid: number,
  replacementIncarnation: ProcessIncarnation,
  build: StrictBundleManifest | null,
): Promise<boolean> {
  const outcome = await retryUpgradeIntentCas(runDir, (observed) => {
    if (
      observed.kind !== 'readable' ||
      waiterAttemptDisposition(runDir, attemptId, spawnNonce, originalPid, originalIncarnation, build) !== 'attempting'
    )
      return { kind: 'settle', value: false };
    return {
      kind: 'write',
      expectedRevision: observed.intent.revision,
      change: {
        ...observed.intent,
        attemptSpawnPending: false,
        attemptChild: { attemptId, pid: replacementPid, incarnation: replacementIncarnation },
      },
      settle: () => true,
    };
  });
  return outcome.kind === 'settled' && outcome.value;
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
    isChildUninterruptible?: (pid: number) => boolean;
    writeRecord?: typeof writeSentinelRecord;
  }> = {},
): Promise<number> {
  const timing = options.timing ?? SENTINEL_TIMING;
  if (!validSentinelTiming(timing)) throw new Error('Invalid coordinator sentinel timing');
  const id = randomUUID();
  const startedAt = Date.now();
  const runDir = process.env.CORAL_SENTINEL_RUN_DIR;
  const originalManifest = validatedBuild(dirname(dirname(executable)));
  let coordinatorIdentity: { coordinatorPid: number; coordinatorIncarnation: ProcessIncarnation | null } | null = null;
  const record = (state: string, fields: Record<string, unknown> = {}): boolean => {
    return (options.writeRecord ?? writeSentinelRecord)(runDir, id, {
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
  if (!record('prepared')) return 1;
  const waiterAttemptId = process.env.CORAL_WAITER_LAUNCHED;
  if (waiterAttemptId !== undefined && !options.fixtureRelaunch) {
    // This CAS races recovery's missing-record release; only its winner may proceed with a spawn.
    const spawnNonce = process.env.CORAL_WAITER_SPAWN_NONCE;
    if (runDir === undefined || !isAbsolute(runDir) || spawnNonce === undefined) {
      record('spawn-fenced');
      return 1;
    }
    const authorized = await retryUpgradeIntentCas(runDir, (observed) => {
      if (observed.kind !== 'readable') return { kind: 'settle', value: false };
      const intent = observed.intent;
      const replacingPid = Number(process.env.CORAL_SENTINEL_REPLACING_PID);
      const replacingIncarnation = processIncarnationSchema.safeParse(process.env.CORAL_SENTINEL_REPLACING_INCARNATION);
      const replacing = Number.isSafeInteger(replacingPid) && replacingPid > 0 && replacingIncarnation.success;
      if (
        intent.disposition !== 'attempting' ||
        intent.attemptId !== waiterAttemptId ||
        intent.attemptSpawnNonce !== spawnNonce ||
        (!replacing && intent.attemptSpawnPending !== true) ||
        (replacing &&
          waiterAttemptDisposition(
            runDir,
            waiterAttemptId,
            spawnNonce,
            replacingPid,
            replacingIncarnation.data,
            originalManifest,
          ) !== 'attempting') ||
        intent.attemptDeadline === null ||
        Date.parse(intent.attemptDeadline) <= Date.now()
      )
        return { kind: 'settle', value: false };
      return {
        kind: 'write',
        expectedRevision: intent.revision,
        change: intent,
        settle: () => true,
      };
    });
    if (authorized.kind !== 'settled' || !authorized.value) {
      record('spawn-fenced');
      return 1;
    }
  }
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
  if (coordinatorIdentity === null) return 1;
  coordinatorIdentity.coordinatorIncarnation ??= probeProcessIncarnation(child.pid);
  const replacingPid = Number(process.env.CORAL_SENTINEL_REPLACING_PID);
  const replacingIncarnation = processIncarnationSchema.safeParse(process.env.CORAL_SENTINEL_REPLACING_INCARNATION);
  if (Number.isSafeInteger(replacingPid) && replacingPid > 0 && replacingIncarnation.success) {
    const rebound =
      runDir !== undefined &&
      isAbsolute(runDir) &&
      process.env.CORAL_STARTUP_ATTEMPT_ID !== undefined &&
      process.env.CORAL_WAITER_SPAWN_NONCE !== undefined &&
      coordinatorIdentity.coordinatorIncarnation !== null &&
      (await rebindWaiterAttempt(
        runDir,
        process.env.CORAL_STARTUP_ATTEMPT_ID,
        process.env.CORAL_WAITER_SPAWN_NONCE,
        replacingPid,
        replacingIncarnation.data,
        child.pid,
        coordinatorIdentity.coordinatorIncarnation,
        originalManifest,
      ));
    if (!rebound) {
      record('replacement-fenced', { coordinatorPid: child.pid });
      child.kill('SIGKILL');
      await exited;
      return 1;
    }
  }
  if (!record('armed', { coordinatorPid: child.pid })) {
    child.kill('SIGKILL');
    await exited;
    return 1;
  }
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
  let dStateSince: number | null = null;
  const isChildUninterruptible = options.isChildUninterruptible ?? childIsUninterruptible;
  const reset = (now: number): void => {
    lastAnswer = now;
    outstanding = null;
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
        record('killing', { coordinatorPid: child.pid, lastAnswer, schedulingGaps });
        child.kill('SIGKILL');
        killed = true;
      }
      return;
    }
    if (dStateSince !== null && child.pid !== undefined && !isChildUninterruptible(child.pid)) {
      dStateSince = null;
      reset(now);
    }
    if (now - lastAnswer >= timing.lapseMs || (dStateSince !== null && now - dStateSince >= timing.dStateDeferralMs)) {
      if (child.pid !== undefined && isChildUninterruptible(child.pid) && dStateSince === null) dStateSince = now;
      if (dStateSince !== null && now - dStateSince < timing.dStateDeferralMs) reset(now);
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
      const attemptId = recoveryEnv.CORAL_STARTUP_ATTEMPT_ID;
      const spawnNonce = recoveryEnv.CORAL_WAITER_SPAWN_NONCE;
      const originalChildIdentity = coordinatorIdentity;
      const waiterDisposition =
        runDir !== undefined &&
        attemptId !== undefined &&
        spawnNonce !== undefined &&
        recoveryEnv.CORAL_WAITER_LAUNCHED === attemptId &&
        originalChildIdentity !== null &&
        originalChildIdentity.coordinatorIncarnation !== null &&
        waiterAttemptDisposition(
          runDir,
          attemptId,
          spawnNonce,
          originalChildIdentity.coordinatorPid,
          originalChildIdentity.coordinatorIncarnation,
          originalManifest,
        );
      if (attemptId !== undefined && recoveryEnv.CORAL_WAITER_LAUNCHED === attemptId && !waiterDisposition) {
        record('relaunch-unavailable', { reason: 'waiter attempt is no longer current' });
        return exitCode;
      }
      if (
        waiterDisposition === 'attempting' &&
        originalChildIdentity !== null &&
        originalChildIdentity.coordinatorIncarnation !== null
      ) {
        recoveryEnv.CORAL_SENTINEL_REPLACING_PID = String(originalChildIdentity.coordinatorPid);
        recoveryEnv.CORAL_SENTINEL_REPLACING_INCARNATION = originalChildIdentity.coordinatorIncarnation;
      } else {
        delete recoveryEnv.CORAL_STARTUP_ATTEMPT_ID;
        delete recoveryEnv.CORAL_WAITER_LAUNCHED;
        delete recoveryEnv.CORAL_WAITER_SPAWN_NONCE;
        delete recoveryEnv.CORAL_SENTINEL_REPLACING_PID;
        delete recoveryEnv.CORAL_SENTINEL_REPLACING_INCARNATION;
      }
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
      const firstAttempts =
        candidates.length === 0 ? [] : Array.from({ length: 3 }, (_, index) => candidates[index % candidates.length]);
      const retainedRoot =
        originalManifest === null ? null : join(dirname(runDir), 'builds', originalManifest.buildSetId);
      const retained = candidates.find((candidate) => dirname(dirname(candidate.backend)) === retainedRoot);
      const attempts =
        retained !== undefined && !firstAttempts.includes(retained) ? [...firstAttempts, retained] : firstAttempts;
      for (const candidate of attempts) {
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
