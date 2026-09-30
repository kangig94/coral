declare const __IS_CORAL_BACKEND_MAIN__: boolean | undefined;
declare const __PLUGIN_ROOT__: string | undefined;

import { resolve } from 'node:path';
import { z } from 'zod';

import { auditBootstrapFailure, writeBootstrapDiagnostic, writeStartupErrorSentinel } from './bootstrap-diagnostics.js';
import { BackendAlreadyRunningError } from './handoff.js';
import {
  HandoffRunError,
  consumeHandoffRunResult,
  runHandoff,
  type DelegatedStartupObservation,
  type HandoffPublicationIncident,
} from './handoff-routing/runner.js';
import type { UnresolvedIncumbentCause } from './handoff-routing/policy.js';
import type { handoffRoutingStatusExitContribution } from './handoff-routing/status.js';
import { createCoordinatorServer } from './index.js';
import { installSuccessionAttemptChild, receiveSuccessionAttemptChild } from './succession/attempt-child.js';
import { parseRetainedEpochArgv, runRetainedEpochCommand } from './services/retained-epoch-executor.js';
import { StartupStoreHandoffError } from './lifecycle.js';
import { SuccessionAttemptStartupHoldError } from './succession/startup.js';
import type { SuccessionInterposition } from './succession/interposition.js';
import { runKbDaemonMain } from '../kb-daemon/daemon-main.js';
import { backendLog } from '../infra/backend-log.js';
import { assertNever } from '../infra/error-format.js';
import { shedInheritedClaudeCodeEnv } from '../infra/env-sanitize.js';
import { errorMessage } from '../infra/error-format.js';
import { createRealRuntime } from '../runtime/real.js';
import { startReplacementSupervisor } from '../runtime/supervisor-loss.js';
import { createRealSuccessionAttemptPorts } from '../runtime/succession-attempt.js';
import { resolveBuildFlavor } from '../infra/build-flavor.js';
import { resolveStrictBundleIdentity } from '../infra/bundle-manifest.js';
import { SENTINEL_TIMING } from '../infra/sentinel-timing.js';
import { updateLaunchStatus } from '../infra/launch-status.js';
import { authenticatedLaunchParent } from '../infra/coordinator-admission.js';
import { parseProviderRoleArgv, type ProviderRole } from '../provider-proxy/role-argv.js';
import { runProviderRoleMain } from '../provider-proxy/role-main.js';
import { currentCoralStoreFormat } from '../store-format.js';
import { generationMutationCoordinationSeam } from '../store/generation-mutation-coordination.js';
import { SIGTERM_GRACE_MS } from '../infra/process-constants.js';
import {
  processIncarnationProbeRegistrySize,
  probeProcessIncarnation,
  incarnationMayAuthorizeSignal,
  snapshotProcessIncarnationProbeSubjects,
  terminateProcessIncarnationProbes,
} from '../infra/node-process.js';

/**
 * Exit codes for a guardian/reaper/proxy role that failed to start, distinct from `0` (success), `1` (a
 * coordinator's own generic startup failure), and `70` (`--print-store-reset-build-identity`'s own strict
 * identity failure) — and distinct per role, so an operator reading the exit code alone knows which role
 * process failed without needing to correlate it against a log line.
 */
const PROVIDER_ROLE_STARTUP_FAILURE_EXIT_CODES: Readonly<Record<ProviderRole, number>> = Object.freeze({
  guardian: 71,
  reaper: 72,
  proxy: 73,
});

/**
 * A nonzero exit says this process did not discharge its obligation; a `startup_failed` diagnostic says the
 * startup failed. Delegated startup nobody could observe is the first and not the second, so it takes an exit
 * code and no diagnostic. The value must stay the one `handoffRoutingStatusExitContribution`
 * (src/coordinator/handoff-routing/status.ts) contributes for the invocation this process leaves unresolved:
 * `coral-backend` and `coral-cli backend status` may not make the same claim with two different numbers.
 */
const UNOBSERVED_STARTUP_DELEGATION_EXIT_CODE: ReturnType<typeof handoffRoutingStatusExitContribution> = 75;

export function createBootstrapProbeExitGate(): Readonly<{
  recordExitCode(code: number): void;
  requestExit(code: number): void;
}> {
  let requestedExitCode: number | null = null;
  let cleanupInFlight = false;
  let exited = false;

  const requestCleanup = (): void => {
    if (cleanupInFlight || exited) return;
    cleanupInFlight = true;
    const cleanupSubjects = snapshotProcessIncarnationProbeSubjects();
    const cleanupAbort = new AbortController();
    const cleanupDeadline = setTimeout(() => cleanupAbort.abort(), SIGTERM_GRACE_MS);
    void terminateProcessIncarnationProbes(cleanupAbort.signal)
      .then(
        (disposition) => {
          if (disposition.disposition !== 'hold') return;
          const holds = disposition.unsettled
            .map((hold) =>
              'key' in hold
                ? `key=${hold.key} reason=${hold.reason} exit=${hold.exit}`
                : `pid=${hold.pid ?? 'unavailable'} reason=${hold.reason} exit=${hold.exit}`,
            )
            .join('; ');
          backendLog.error(`Coordinator exit proceeding with unsettled process-incarnation probes: ${holds}`);
        },
        (error: unknown) => {
          const subjects = cleanupSubjects
            .map((subject) => ('key' in subject ? `key=${subject.key}` : `pid=${subject.pid}`))
            .join('; ');
          backendLog.error(
            `Coordinator exit proceeding after process-incarnation probe cleanup failed; registered subjects: ${subjects || 'none'}`,
            error,
          );
        },
      )
      .then(() => {
        clearTimeout(cleanupDeadline);
        cleanupInFlight = false;
        if (requestedExitCode !== null) {
          exited = true;
          process.exit(requestedExitCode);
        }
      });
  };

  const recordExitCode = (code: number): void => {
    requestedExitCode = requestedExitCode === null ? code : Math.max(requestedExitCode, code);
  };

  return {
    recordExitCode,
    requestExit: (code): void => {
      recordExitCode(code);
      if (processIncarnationProbeRegistrySize() === 0 && requestedExitCode !== null) {
        exited = true;
        process.exit(requestedExitCode);
      }
      requestCleanup();
    },
  };
}

const bootstrapProbeExitGate = createBootstrapProbeExitGate();

export function createCoordinatorShutdownSignalHandler(options: {
  readonly shutdown: (reason: 'sigterm' | 'sigint') => Promise<unknown>;
  readonly recordExitCode: (code: number) => void;
  readonly onRepeatedSignal?: () => void;
}): (reason: 'sigterm' | 'sigint') => void {
  let signalCount = 0;
  return (reason) => {
    signalCount += 1;
    if (signalCount > 1) {
      options.recordExitCode(1);
      options.onRepeatedSignal?.();
    }
    void options.shutdown(reason).catch(() => {});
  };
}

async function handleSmokeOpenStore(argv: readonly string[]): Promise<number> {
  const pathIdx = argv.indexOf('--path');
  if (pathIdx === -1 || !argv[pathIdx + 1]) {
    backendLog.error('smoke open-store: missing --path');
    return 1;
  }

  try {
    const runtime = createRealRuntime(resolveBuildFlavor(process.env));
    const { openWritableStoreDbNoReset, resolveProvenStoreEpochAtPath } = await import('../store/epoch.js');
    const smokeStorePathInput = z
      .string()
      .refine((path) => resolve(path) === path, 'path is not a canonical absolute path');
    const parsed = smokeStorePathInput.safeParse(argv[pathIdx + 1]);
    if (!parsed.success) {
      throw new Error(`smoke open-store path refused: ${parsed.error.issues.map(({ message }) => message).join('; ')}`);
    }
    const store = resolveProvenStoreEpochAtPath(runtime.storage, runtime.paths.coral.store.dbDir, parsed.data);
    if (store === null) {
      throw new Error('smoke open-store path refused: path is not a proven canonical positive store epoch');
    }
    const writerLease = await generationMutationCoordinationSeam.acquireWriterLease(runtime, {
      kind: 'routing-status',
      name: 'smoke-open-store',
    });

    try {
      const db = openWritableStoreDbNoReset(runtime, {
        resolved: store,
        storeFormat: currentCoralStoreFormat(),
      });

      try {
        db.exec('BEGIN IMMEDIATE');
        db.exec('CREATE TEMP TABLE coral_smoke_open_store (ok INTEGER NOT NULL CHECK (ok = 1))');
        db.exec('INSERT INTO coral_smoke_open_store (ok) VALUES (1)');
        const readBack = db.prepare<[], { ok: number }>('SELECT ok FROM coral_smoke_open_store').get();
        db.exec('DROP TABLE coral_smoke_open_store');
        db.exec('COMMIT');
        if (readBack?.ok !== 1) {
          backendLog.error('smoke read-back failed');
          return 1;
        }

        process.stdout.write('ok\n');
        return 0;
      } finally {
        db.close();
      }
    } finally {
      writerLease.release();
    }
  } catch (error: unknown) {
    const message = errorMessage(error);
    backendLog.error('smoke open-store failed', message);
    return 1;
  }
}

/**
 * `undetermined` is not a quiet `failed`: it may not reach a diagnostic, a sentinel, or an audit event, since
 * every one of those records a startup failure this process did not observe.
 */
type DelegatedStartupResult =
  | Readonly<{ kind: 'started' }>
  | Readonly<{ kind: 'failed'; error: unknown; exitCode: number }>
  | Readonly<{ kind: 'undetermined'; cause: UnresolvedIncumbentCause }>;

function delegatedStartupResult(observation: DelegatedStartupObservation): DelegatedStartupResult {
  switch (observation.kind) {
    case 'serving':
      return { kind: 'started' };
    case 'not-serving': {
      const { childEnding } = observation;
      if (childEnding.signal !== null) {
        return {
          kind: 'failed',
          error: new Error(`Selected backend ended during startup handoff from signal ${childEnding.signal}.`),
          exitCode: 1,
        };
      }
      // Exiting 0 without taking over is still a failure to become the backend, so this process must exit
      // nonzero. The child's own code is the record's; forcing it here would not reach the record.
      return {
        kind: 'failed',
        error: new Error(
          `Selected backend exited during startup handoff with code ${childEnding.code ?? 'unreported'} without ` +
            'taking over as the coordinator.',
        ),
        exitCode: childEnding.code === null || childEnding.code === 0 ? 1 : childEnding.code,
      };
    }
    case 'undetermined':
      return { kind: 'undetermined', cause: observation.cause };
    default:
      return assertNever(observation);
  }
}

export async function handoffStartupToSelectedBuild(
  pluginRoot: string,
  startupError: StartupStoreHandoffError,
): Promise<DelegatedStartupResult> {
  try {
    const result = await runHandoff(
      { kind: 'backend-startup' },
      {
        pluginRoot,
        activeSelectionTarget: startupError.target,
        onSelectionPublicationIncident: logStartupHandoffPublicationIncident,
      },
    );
    const continuation = consumeHandoffRunResult(result, (incidents) =>
      incidents.filter((incident) => incident.phase === 'terminal').forEach(logStartupHandoffPublicationIncident),
    );
    return continuation.kind === 'run-current'
      ? {
          kind: 'failed',
          error: new Error('Selected backend startup handoff did not delegate to the selected build.'),
          exitCode: 1,
        }
      : delegatedStartupResult(continuation.observation);
  } catch (error: unknown) {
    if (error instanceof HandoffRunError) {
      error.incidents.filter((incident) => incident.phase === 'terminal').forEach(logStartupHandoffPublicationIncident);
      return { kind: 'failed', error: error.originalError, exitCode: 1 };
    }
    return { kind: 'failed', error, exitCode: 1 };
  }
}

function logStartupHandoffPublicationIncident(incident: HandoffPublicationIncident): void {
  backendLog.warn(`Backend startup handoff routing-status publication incident: ${JSON.stringify(incident)}`);
}

export type BackendHarness = Readonly<{
  successionInterposition?: SuccessionInterposition;
  afterReady?: () => void;
}>;

async function dispatchBackendRole(): Promise<number | null> {
  // Before any child spawn, shed the Claude Code identity inherited from the daemon's launcher.
  shedInheritedClaudeCodeEnv(process.env);

  if (process.argv.includes('--print-store-format-fingerprint')) {
    process.stdout.write(`${currentCoralStoreFormat().fingerprint}\n`);
    return 0;
  }

  if (process.argv.length === 3 && process.argv[2] === '--print-store-reset-build-identity') {
    const identity = resolveStrictBundleIdentity();
    if (!identity.ok) return 70;
    process.stdout.write(`${JSON.stringify(identity.manifest)}\n`);
    return 0;
  }

  const retainedEpochCommand = parseRetainedEpochArgv(process.argv);
  if (retainedEpochCommand !== null) {
    return runRetainedEpochCommand(retainedEpochCommand, createRealRuntime, currentCoralStoreFormat());
  }

  // Provider-proxy roles must be dispatched before coordinator construction.
  const providerRole = parseProviderRoleArgv(process.argv);
  if (providerRole.role !== 'none') {
    try {
      return await runProviderRoleMain(providerRole, {
        pluginRoot: typeof __PLUGIN_ROOT__ === 'string' ? __PLUGIN_ROOT__ : process.cwd(),
      });
    } catch (error: unknown) {
      // Provider role failures must not be recorded as coordinator bootstrap failures.
      backendLog.error(`Provider ${providerRole.role} role failed to start`, error);
      return PROVIDER_ROLE_STARTUP_FAILURE_EXIT_CODES[providerRole.role];
    }
  }

  if (process.env.CORAL_KB_DAEMON === '1') {
    return runKbDaemonMain({
      pluginRoot: typeof __PLUGIN_ROOT__ === 'string' ? __PLUGIN_ROOT__ : process.cwd(),
    });
  }

  if (process.argv.includes('--smoke-open-store')) {
    return handleSmokeOpenStore(process.argv);
  }

  return null;
}

/**
 * Linux accepts the residual check-to-signal race after a fresh parent incarnation check. macOS cannot provide
 * signal authority, so a silent parent retains a visible hold until it cooperates or exits.
 */
async function armSupervisorSentinel(replaceSupervisor: () => void, onSentinelLoss: () => void): Promise<void> {
  let sentinelArm: Promise<void> | null = null;
  if (process.env.CORAL_SENTINEL_ID !== undefined) {
    const sentinelId = process.env.CORAL_SENTINEL_ID;
    const parent = authenticatedLaunchParent();
    const parentPid = parent?.pid ?? process.ppid;
    const parentIncarnation = parent?.incarnation ?? null;
    let parentObservation = probeProcessIncarnation(parentPid);
    const holdId = `parent:${parentPid}`;
    let parentSilent = false;
    let parentTermDeliveredAt: number | null = null;
    let parentKillSent = false;
    let lastParentProgress = Date.now();
    let lastWake = lastParentProgress;
    const recordParentHold = (held: boolean): void => {
      const runDir = process.env.CORAL_SENTINEL_RUN_DIR;
      if (runDir === undefined) return;
      try {
        updateLaunchStatus(runDir, (status) => ({
          ...status,
          signalHolds: [
            ...status.signalHolds.filter((hold) => hold.launchId !== holdId),
            ...(held
              ? [
                  {
                    launchId: holdId,
                    pid: parentPid,
                    incarnation: parentIncarnation ?? 'unavailable',
                    disposition:
                      parentObservation === null ? ('parent-identity-unknown' as const) : ('parent-silent' as const),
                    observation: parentObservation ?? 'unknown',
                  },
                ]
              : []),
          ],
        }));
      } catch (error: unknown) {
        backendLog.error('Could not record unresponsive supervisor hold', error);
      }
    };
    const signalSilentParent = (signal: 'SIGTERM' | 'SIGKILL'): boolean => {
      if (process.platform !== 'linux' || !incarnationMayAuthorizeSignal(process.platform)) return false;
      if (parentIncarnation === null || process.ppid !== parentPid) return false;
      parentObservation = probeProcessIncarnation(parentPid);
      if (parentObservation !== parentIncarnation) return false;
      try {
        return process.kill(parentPid, signal);
      } catch {
        return false;
      }
    };
    const parentAnswered = (): void => {
      if (parentTermDeliveredAt !== null || parentKillSent) return;
      lastParentProgress = Date.now();
      if (!parentSilent) return;
      parentSilent = false;
      parentTermDeliveredAt = null;
      parentKillSent = false;
      recordParentHold(false);
    };
    const supervisorMonitor = setInterval(() => {
      const now = Date.now();
      const gap = now - lastWake;
      lastWake = now;
      if (gap > SENTINEL_TIMING.schedulingGapMs) {
        lastParentProgress = now;
        return;
      }
      if (now - lastParentProgress < SENTINEL_TIMING.lapseMs) return;
      if (!parentSilent) {
        parentSilent = true;
        replaceSupervisor();
      }
      if (process.ppid !== parentPid) return recordParentHold(false);
      parentObservation = probeProcessIncarnation(parentPid);
      const killDue = parentTermDeliveredAt !== null && now >= parentTermDeliveredAt + SENTINEL_TIMING.graceMs;
      if (killDue && !parentKillSent) parentKillSent = signalSilentParent('SIGKILL');
      else if (parentTermDeliveredAt === null && signalSilentParent('SIGTERM')) parentTermDeliveredAt = now;
      recordParentHold(killDue ? !parentKillSent : parentTermDeliveredAt === null);
    }, SENTINEL_TIMING.challengeMs);
    supervisorMonitor.unref();
    sentinelArm = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Coordinator sentinel did not arm before startup')), 30_000);
      const onArm = (message: unknown): void => {
        if (
          typeof message === 'object' &&
          message !== null &&
          'kind' in message &&
          message.kind === 'coral-sentinel-armed' &&
          'id' in message &&
          message.id === sentinelId
        ) {
          clearTimeout(timeout);
          process.off('message', onArm);
          resolve();
        }
      };
      process.on('message', onArm);
      process.send?.({ kind: 'coral-sentinel-hello', id: sentinelId });
    });
    process.on('message', (message: unknown) => {
      if (
        typeof message === 'object' &&
        message !== null &&
        'kind' in message &&
        message.kind === 'coral-sentinel-challenge' &&
        'id' in message &&
        Number.isSafeInteger(message.id)
      ) {
        parentAnswered();
        process.send?.({ kind: 'coral-sentinel-answer', id: message.id });
      }
    });
    process.on('disconnect', () => {
      if (parentSilent) recordParentHold(false);
      onSentinelLoss();
    });
  }
  if (sentinelArm !== null) await sentinelArm;
}

async function handleCoordinatorStartupFailure(
  pluginRoot: string,
  successionAttempt: Awaited<ReturnType<typeof receiveSuccessionAttemptChild>>,
  error: unknown,
): Promise<number> {
  if (successionAttempt !== null) {
    backendLog.warn(
      error instanceof SuccessionAttemptStartupHoldError
        ? error.message
        : `Succession attempt startup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
  if (error instanceof BackendAlreadyRunningError) {
    backendLog.info(error.message);
    return 0;
  }
  if ((error as { name?: string } | null)?.name === 'AbortError') {
    return 0;
  }

  let startupError = error;
  let startupExitCode = 1;
  if (error instanceof StartupStoreHandoffError) {
    const handoff = await handoffStartupToSelectedBuild(pluginRoot, error);
    switch (handoff.kind) {
      case 'started':
        return 0;
      case 'undetermined':
        backendLog.warn(
          `This process delegated startup to the selected Coral build and could not observe whether that build ` +
            `is now serving (${handoff.cause}). No startup failure is recorded, because none was observed. Run ` +
            `'coral-cli backend status' to see whether the selected build is serving, and to settle the routing ` +
            `invocation this process left unresolved.`,
        );
        return UNOBSERVED_STARTUP_DELEGATION_EXIT_CODE;
      case 'failed':
        startupError = handoff.error;
        startupExitCode = handoff.exitCode;
        break;
      default:
        return assertNever(handoff);
    }
  }

  backendLog.error('Fatal startup error', startupError);
  const diagnosticFile = writeBootstrapDiagnostic(pluginRoot, 'startup_failed', startupError, startupExitCode);
  writeStartupErrorSentinel(pluginRoot, startupError, diagnosticFile);
  auditBootstrapFailure(
    'bootstrap_startup_failed',
    pluginRoot,
    'startup_failed',
    startupError,
    startupExitCode,
    diagnosticFile,
  );
  return startupExitCode;
}

export async function main(harness: BackendHarness = {}): Promise<number> {
  const dispatched = await dispatchBackendRole();
  if (dispatched !== null) return dispatched;

  if (typeof __PLUGIN_ROOT__ !== 'string') {
    throw new Error('Coral backend bootstrap requires __PLUGIN_ROOT__ to be defined at build time.');
  }

  const runningIdentity = resolveStrictBundleIdentity();
  let repairAfterSupervisorAccepted = (_pluginRoot: string): Promise<void> => Promise.resolve();
  let replacingSupervisor = false;
  const replaceSupervisor = (): void => {
    if (replacingSupervisor) return;
    const runDir = process.env.CORAL_SENTINEL_RUN_DIR;
    if (!runningIdentity.ok || runDir === undefined) {
      backendLog.error('Could not replace coordinator supervisor: running build identity is unavailable');
      return;
    }
    replacingSupervisor = true;
    startReplacementSupervisor(
      __PLUGIN_ROOT__,
      runDir,
      runningIdentity.manifest,
      (error) => backendLog.error('Could not replace coordinator supervisor', error),
      (pluginRoot) => repairAfterSupervisorAccepted(pluginRoot),
    );
  };
  let shutdownAfterSentinelLoss = (): void => {
    replaceSupervisor();
    bootstrapProbeExitGate.requestExit(1);
  };
  await armSupervisorSentinel(replaceSupervisor, () => shutdownAfterSentinelLoss());

  const successionAttempt = await receiveSuccessionAttemptChild(createRealSuccessionAttemptPorts());
  installSuccessionAttemptChild(successionAttempt);

  // Startup must retain a referenced handle until `start()` resolves.
  const startupKeepalive = setInterval(() => {}, 60_000);

  try {
    const coordinator = createCoordinatorServer({
      ...harness,
      pluginRoot: __PLUGIN_ROOT__,
      ...(successionAttempt === null ? {} : { bootSnapshot: { bootToken: successionAttempt.bootToken } }),
      onStopped: (exitCode = 0) => {
        bootstrapProbeExitGate.requestExit(exitCode);
      },
      acceptProcessExitRemainder: (remainder) => ({
        kind: 'accepted',
        remainder,
        requestExit: (exitCode) => bootstrapProbeExitGate.requestExit(exitCode),
      }),
      onFatalShutdownError: (error) => {
        backendLog.error('Fatal shutdown error', error);
        const diagnosticFile = writeBootstrapDiagnostic(__PLUGIN_ROOT__, 'fatal_shutdown_error', error, 1);
        auditBootstrapFailure(
          'bootstrap_fatal_shutdown',
          __PLUGIN_ROOT__,
          'fatal_shutdown_error',
          error,
          1,
          diagnosticFile,
        );
        bootstrapProbeExitGate.requestExit(1);
      },
    });
    repairAfterSupervisorAccepted = (pluginRoot) => {
      if (!runningIdentity.ok) return Promise.reject(new Error('Running build identity is unavailable'));
      return coordinator.repairSupervision({ build: runningIdentity.manifest, pluginRootLabel: pluginRoot });
    };
    shutdownAfterSentinelLoss = replaceSupervisor;

    const handleShutdownSignal = createCoordinatorShutdownSignalHandler({
      shutdown: coordinator.shutdown,
      recordExitCode: bootstrapProbeExitGate.recordExitCode,
      onRepeatedSignal: () => backendLog.warn('Repeated shutdown signal received; eventual safe exit is now nonzero.'),
    });
    process.on('SIGTERM', () => handleShutdownSignal('sigterm'));
    process.on('SIGINT', () => handleShutdownSignal('sigint'));

    const info = await coordinator.start();
    harness.afterReady?.();
    backendLog.info(`Running on ${info.host}:${info.port}`);
    return 0;
  } catch (error: unknown) {
    return await handleCoordinatorStartupFailure(__PLUGIN_ROOT__, successionAttempt, error);
  } finally {
    clearInterval(startupKeepalive);
  }
}

export function runBackendMain(harness: BackendHarness = {}): void {
  void main(harness)
    .then((code) => {
      if (code !== 0) {
        bootstrapProbeExitGate.requestExit(code);
      } else {
        // A contender that conceded has no server to keep it alive. The private sentinel channel must not
        // turn that normal return into a process that lives only to answer heartbeats.
        process.channel?.unref();
      }
    })
    .catch((error: unknown) => {
      backendLog.error('Fatal startup error', error);
      if (typeof __PLUGIN_ROOT__ === 'string') {
        const diagnosticFile = writeBootstrapDiagnostic(__PLUGIN_ROOT__, 'bootstrap_unhandled_rejection', error, 1);
        auditBootstrapFailure(
          'bootstrap_unhandled_rejection',
          __PLUGIN_ROOT__,
          'bootstrap_unhandled_rejection',
          error,
          1,
          diagnosticFile,
        );
      }
      bootstrapProbeExitGate.requestExit(1);
    });
}

if (typeof __IS_CORAL_BACKEND_MAIN__ !== 'undefined' && __IS_CORAL_BACKEND_MAIN__) runBackendMain();
