import { errorMessage } from '../../../infra/error-format.js';
import { incarnationMayAuthorizeSignal, type ProcessIncarnation } from '../../../infra/node-process.js';
import { createMonotonicClock } from '../../../infra/monotonic-clock.js';
import {
  ProcessContainmentError,
  reapRecordedContainment,
  type RecordedContainmentIdentity,
} from '../../../infra/process-containment.js';
import type { ControlClient, ControlExchange } from '../../../provider-proxy/control-client.js';
import { PROXY_TEARDOWN_RESERVE_MS } from '../../../provider-proxy/orphan-deadline.js';
import {
  guardianContainmentCommitParamsSchema,
  guardianContainmentCommitResultSchema,
  GUARDIAN_CONSTRUCTION_CONTAINMENT_SETTLED_EXIT_CODE,
  type GuardianIdentity,
  type ProxyIdentity,
  type ReaperIdentity,
} from '../../../provider-proxy/protocol.js';
import type { SpawnedRoleProcess } from '../../../provider-proxy/role-spawn.js';
import type { Runtime } from '../../../runtime/ports.js';

type GuardianControlTeardown = Readonly<{
  client: ControlClient;
  guardian: GuardianIdentity;
  reaper: ReaperIdentity;
  proxy: ProxyIdentity;
}>;

const guardianSpawnUndoClockScope: unique symbol = Symbol('coral.provider-proxy.guardian-spawn-undo');

export type GuardianSpawnUndo = (() => Promise<void>) &
  Readonly<{
    guardianIdentity: RecordedContainmentIdentity;
    retainPossibleProxy(): void;
    bindProxyIdentity(identity: RecordedContainmentIdentity): void;
    bindControl(control: GuardianControlTeardown): void;
  }>;

function requireAcknowledgedAbsence(exchange: ControlExchange): void {
  if (exchange.kind !== 'response') {
    throw new Error(`guardian acquisition teardown could not be confirmed: ${errorMessage(exchange.error)}`);
  }
  if (exchange.response.kind === 'refusal') {
    throw new Error(`guardian acquisition teardown was refused: ${exchange.response.error.message}`);
  }
  const parsed = guardianContainmentCommitResultSchema.safeParse(exchange.response.value);
  if (!parsed.success) {
    throw new Error(`guardian acquisition teardown replied with an undecodable result: ${parsed.error.message}`);
  }
  if (parsed.data.state === 'teardown-latched-absence-unconfirmed') {
    throw new Error(`guardian acquisition teardown was refused: ${parsed.data.reason}`);
  }
}

/** A control-plane refusal must strand the guardian without falling back to process signals. */
export function buildGuardianSpawnUndo(
  runtime: Runtime,
  spawned: SpawnedRoleProcess,
  platform: NodeJS.Platform,
  readProcessIncarnation: (pid: number, platform: NodeJS.Platform) => ProcessIncarnation | null,
): GuardianSpawnUndo {
  let control: GuardianControlTeardown | null = null;
  let proxyIdentity: RecordedContainmentIdentity | null = null;
  let proxyMayExist = false;
  let constructionContainmentSettled = false;
  let absenceConfirmed = false;
  let pending: Promise<void> | null = null;
  const guardianIdentity: RecordedContainmentIdentity = {
    pid: spawned.pid,
    incarnation: spawned.incarnation,
    processGroupId: spawned.pid,
  };

  const perform = async (): Promise<void> => {
    if (absenceConfirmed) return;
    if (control !== null) {
      const established = control;
      const exchange = await established.client.exchange(
        'guardian.containment-commit.v1',
        guardianContainmentCommitParamsSchema.parse({
          guardian: established.guardian,
          reaper: established.reaper,
          proxy: established.proxy,
        }),
        PROXY_TEARDOWN_RESERVE_MS,
      );
      requireAcknowledgedAbsence(exchange);
      absenceConfirmed = true;
      established.client.close();
      return;
    }

    if (proxyMayExist && proxyIdentity === null) {
      if (constructionContainmentSettled) {
        absenceConfirmed = true;
        return;
      }
      throw new Error(
        'guardian process-group cleanup is holding until the guardian reports construction containment settled or the proxy identity transfers to the coordinator',
      );
    }
    const retainedProxyIdentity = proxyIdentity;

    if (!incarnationMayAuthorizeSignal(platform))
      return Promise.reject(
        new Error(
          'guardian process-group cleanup is holding because this platform cannot bind a signal to its recorded incarnation',
        ),
      );
    const clock = createMonotonicClock(guardianSpawnUndoClockScope, {
      readMilliseconds: () => runtime.time.monotonicNow(),
      sleep: (milliseconds) => runtime.time.sleep(milliseconds),
    });
    try {
      if (retainedProxyIdentity !== null) {
        const proxyResult = await reapRecordedContainment(
          retainedProxyIdentity,
          [],
          clock.shiftMilliseconds(clock.now(), PROXY_TEARDOWN_RESERVE_MS),
          {
            maxRecordedRoots: 0,
            clock,
            process: runtime.process,
            platform,
            readProcessIncarnation,
          },
        );
        if (proxyResult.kind === 'recorded-group-unattributable') {
          throw new Error('proxy process-group cleanup is holding because the recorded group became unattributable');
        }
        if (proxyResult.kind === 'signal-authorization-refused') {
          throw new Error('proxy process-group cleanup is holding because signal authorization was refused');
        }
        if (proxyResult.kind === 'identity-unobservable') {
          throw new Error(
            proxyResult.signalDelivered
              ? 'proxy process-group cleanup is holding because identity became unobservable after a signal was delivered'
              : 'proxy process-group cleanup is holding because identity observation did not authorize a signal',
          );
        }
      }
      const result = await reapRecordedContainment(
        guardianIdentity,
        [],
        clock.shiftMilliseconds(clock.now(), PROXY_TEARDOWN_RESERVE_MS),
        {
          maxRecordedRoots: 0,
          clock,
          process: runtime.process,
          platform,
          readProcessIncarnation,
        },
      );
      if (result.kind === 'recorded-group-unattributable') {
        throw new Error('guardian process-group cleanup is holding because the recorded group became unattributable');
      }
      if (result.kind === 'signal-authorization-refused') {
        throw new Error('guardian process-group cleanup is holding because signal authorization was refused');
      }
      if (result.kind === 'identity-unobservable') {
        throw new Error(
          result.signalDelivered
            ? 'guardian process-group cleanup is holding because identity became unobservable after a signal was delivered'
            : 'guardian process-group cleanup is holding because identity observation did not authorize a signal',
        );
      }
      absenceConfirmed = true;
    } catch (error: unknown) {
      if (error instanceof ProcessContainmentError) {
        throw new Error('guardian process-group cleanup is holding because absence could not be confirmed', {
          cause: error,
        });
      }
      throw error;
    }
  };
  const run = (): Promise<void> => {
    if (absenceConfirmed) return Promise.resolve();
    if (pending !== null) return pending;
    pending = perform().finally(() => {
      pending = null;
    });
    return pending;
  };
  return Object.assign(run, {
    guardianIdentity,
    retainPossibleProxy: (): void => {
      if (proxyMayExist) return;
      proxyMayExist = true;
      spawned.child.on('close', (code, signal) => {
        if (code === GUARDIAN_CONSTRUCTION_CONTAINMENT_SETTLED_EXIT_CODE && signal === null) {
          constructionContainmentSettled = true;
        }
      });
    },
    bindProxyIdentity: (identity: RecordedContainmentIdentity): void => {
      proxyMayExist = true;
      proxyIdentity = identity;
    },
    bindControl: (established: GuardianControlTeardown): void => {
      control = established;
    },
  });
}
