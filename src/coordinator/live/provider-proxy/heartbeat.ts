import { backendLog } from '../../../infra/backend-log.js';
import { errorMessage } from '../../../infra/error-format.js';
import { PROXY_CONTROL_HEARTBEAT_MS } from '../../../provider-proxy/orphan-deadline.js';
import { PROXY_CONTROL_RPC_TIMEOUT_MS, controlHeartbeatParamsSchema } from '../../../provider-proxy/protocol.js';
import type { Runtime } from '../../../runtime/ports.js';
import type { ControlClient } from '../../../provider-proxy/control-client.js';
import {
  applyLocalFailure,
  heartbeatObservationFromExchange,
  type HeartbeatObservation,
} from '../../../provider-proxy/heartbeat-observation.js';
import type {
  ProviderProxyAuthorityFaultLatch,
  ProviderProxyHeartbeatMethod,
  ProviderProxyHeartbeatTerminalReason,
  ProviderProxyRole,
} from '../../services/provider-proxy-authority-fault.js';

/** Sends one heartbeat through the transport's provenance-preserving exchange surface. */
export async function heartbeatOnce(
  client: ControlClient,
  method: string,
  controlEpoch: number,
  heartbeatChallenge: string,
): Promise<HeartbeatObservation> {
  const params = controlHeartbeatParamsSchema.parse({ controlEpoch, heartbeatChallenge });
  const exchange = await client.exchange(method, params, PROXY_CONTROL_RPC_TIMEOUT_MS);
  return heartbeatObservationFromExchange(exchange);
}

export type HeartbeatLoop = Readonly<{ stop(): void }>;

export type ProviderProxyHeartbeatSession = Readonly<{
  client: ControlClient;
  controlEpoch: number;
  nextHeartbeatChallenge: string;
  instanceId: string;
}>;

export type ProviderProxyRoleHeartbeats = Readonly<{
  proxy: HeartbeatLoop;
  guardian: HeartbeatLoop;
  reaper: HeartbeatLoop;
}>;

export type ProviderProxyAuthorityHeartbeatAssembly = Readonly<{
  startRole(role: ProviderProxyRole, session: ProviderProxyHeartbeatSession): void;
  complete(): ProviderProxyRoleHeartbeats;
  stop(): void;
}>;

const HEARTBEAT_METHOD_BY_ROLE = {
  proxy: 'control.heartbeat.v1',
  guardian: 'guardian.heartbeat.v1',
  reaper: 'reaper.heartbeat.v1',
} as const satisfies Record<ProviderProxyRole, ProviderProxyHeartbeatMethod>;

type HeartbeatLoopState =
  | Readonly<{ kind: 'idle'; challenge: string }>
  | Readonly<{ kind: 'in-flight'; challenge: string; attempt: symbol; schedulerLatenessMs: number }>
  | Readonly<{ kind: 'stopped' }>;

function startHeartbeatLoop(
  client: ControlClient,
  method: string,
  runtime: Runtime,
  controlEpoch: number,
  firstNextChallenge: string,
  onObservation: (observation: HeartbeatObservation, schedulerLatenessMs: number) => void,
  onChannelFault: (error: Extract<HeartbeatObservation, { kind: 'channel-fault' }>['error']) => void,
  onTerminal: (error: unknown, reason: ProviderProxyHeartbeatTerminalReason) => void,
): HeartbeatLoop {
  let state: HeartbeatLoopState = { kind: 'idle', challenge: firstNextChallenge };
  let requestedWakeMs = runtime.time.monotonicNow() + BigInt(PROXY_CONTROL_HEARTBEAT_MS);
  let pendingSchedulerLatenessMs = 0;
  const tick = (): void => {
    const observedWakeMs = runtime.time.monotonicNow();
    if (observedWakeMs > requestedWakeMs) {
      pendingSchedulerLatenessMs += Number(observedWakeMs - requestedWakeMs);
    }
    requestedWakeMs = observedWakeMs + BigInt(PROXY_CONTROL_HEARTBEAT_MS);
    if (state.kind !== 'idle') return;
    const { challenge } = state;
    const attempt = Symbol('provider-proxy-heartbeat');
    const schedulerLatenessMs = pendingSchedulerLatenessMs;
    pendingSchedulerLatenessMs = 0;
    state = { kind: 'in-flight', challenge, attempt, schedulerLatenessMs };
    void heartbeatOnce(client, method, controlEpoch, challenge).then(
      (observation) => {
        if (state.kind !== 'in-flight' || state.attempt !== attempt) return;
        const observedSchedulerLatenessMs = state.schedulerLatenessMs + pendingSchedulerLatenessMs;
        pendingSchedulerLatenessMs = 0;
        if (observation.kind === 'reply') {
          if (observation.reply.kind === 'teardown-latched') {
            state = { kind: 'stopped' };
            runtime.time.clearInterval(handle);
            onObservation(observation, observedSchedulerLatenessMs);
            onTerminal(observation.reply.error, 'teardown-latched');
            return;
          }
          if (observation.reply.kind === 'method-not-found') {
            state = { kind: 'stopped' };
            runtime.time.clearInterval(handle);
            onObservation(observation, observedSchedulerLatenessMs);
            return;
          }
          const nextChallenge =
            observation.reply.kind === 'accepted' || observation.reply.kind === 'challenge-mismatch'
              ? observation.reply.nextChallenge
              : challenge;
          state = { kind: 'idle', challenge: nextChallenge };
          onObservation(observation, observedSchedulerLatenessMs);
          return;
        }
        if (observation.kind === 'no-response-before-deadline') {
          state = { kind: 'idle', challenge };
          onObservation(observation, observedSchedulerLatenessMs);
          return;
        }
        state = { kind: 'stopped' };
        runtime.time.clearInterval(handle);
        const localFailure = applyLocalFailure(observation);
        onObservation(observation, observedSchedulerLatenessMs);
        if (localFailure.effect === 'channel-fault') {
          onChannelFault(localFailure.error);
          return;
        }
        onTerminal(localFailure.error, 'local-failure');
      },
      (error: unknown) => {
        if (state.kind !== 'in-flight' || state.attempt !== attempt) return;
        state = { kind: 'stopped' };
        runtime.time.clearInterval(handle);
        onTerminal(error, 'local-failure');
      },
    );
  };
  const handle = runtime.time.setInterval(tick, PROXY_CONTROL_HEARTBEAT_MS);
  handle.unref?.();
  return {
    stop: () => {
      if (state.kind === 'stopped') return;
      state = { kind: 'stopped' };
      runtime.time.clearInterval(handle);
    },
  };
}

export function createProviderProxyAuthorityHeartbeatAssembly(
  runtime: Runtime,
  faults: ProviderProxyAuthorityFaultLatch,
): ProviderProxyAuthorityHeartbeatAssembly {
  const loops = new Map<ProviderProxyRole, HeartbeatLoop>();

  const startRole = (role: ProviderProxyRole, session: ProviderProxyHeartbeatSession): void => {
    if (loops.has(role)) throw new Error(`provider_proxy_heartbeat_role_already_started:${role}`);
    faults.observeControlClient(role, session.client);
    const method = HEARTBEAT_METHOD_BY_ROLE[role];
    loops.set(
      role,
      startHeartbeatLoop(
        session.client,
        method,
        runtime,
        session.controlEpoch,
        session.nextHeartbeatChallenge,
        (observation, schedulerLatenessMs) => {
          faults.reportIncident({
            kind: 'heartbeat-observation',
            role,
            method,
            observation,
            schedulerLatenessMs,
          });
        },
        (error) => faults.latch({ kind: 'control-channel-fault', role, error }),
        (error, terminalReason) => {
          faults.latch({ kind: 'heartbeat-failed', role, method, terminalReason, error });
          const observed =
            terminalReason === 'teardown-latched' ? 'heartbeat echo was refused' : 'heartbeat call failed locally';
          backendLog.warn(`provider-proxy ${role} ${observed} for ${session.instanceId}: ${errorMessage(error)}`);
        },
      ),
    );
  };

  return {
    startRole,
    complete() {
      const proxy = loops.get('proxy');
      const guardian = loops.get('guardian');
      const reaper = loops.get('reaper');
      if (proxy === undefined || guardian === undefined || reaper === undefined) {
        throw new Error('provider_proxy_heartbeat_roles_incomplete');
      }
      return { proxy, guardian, reaper };
    },
    stop() {
      for (const loop of loops.values()) loop.stop();
    },
  };
}
