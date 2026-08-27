import { backendLog } from '../../../infra/backend-log.js';
import { errorMessage } from '../../../infra/error-format.js';
import { PROXY_CONTROL_HEARTBEAT_MS } from '../../../provider-proxy/orphan-deadline.js';
import {
  PROXY_CONTROL_RPC_TIMEOUT_MS,
  controlHeartbeatParamsSchema,
  controlHeartbeatResultSchema,
} from '../../../provider-proxy/protocol.js';
import type { Runtime } from '../../../runtime/ports.js';
import { ControlClientError, type ControlClient } from '../../../provider-proxy/control-client.js';
import type {
  ProviderProxyAuthorityFaultLatch,
  ProviderProxyHeartbeatIncidentReason,
  ProviderProxyHeartbeatMethod,
  ProviderProxyHeartbeatTerminalReason,
  ProviderProxyRole,
} from '../../services/provider-proxy-authority-fault.js';

/**
 * The peer answered, but this build could not decode the reply into `controlHeartbeatResultSchema` — a
 * disposition about what came back over the wire, never about whether this process could ask. Thrown by
 * `heartbeatOnce` so `heartbeatFailureDisposition` can tell it apart from a schema failure on the request side,
 * which never reaches the wire at all.
 */
export class HeartbeatReplyUndecodableError extends Error {
  constructor(cause: unknown) {
    super('provider_proxy_heartbeat_reply_undecodable', { cause });
    this.name = 'HeartbeatReplyUndecodableError';
    Object.setPrototypeOf(this, HeartbeatReplyUndecodableError.prototype);
  }
}

/** Sends one heartbeat and returns the next challenge. Exported so `role-control.ts`'s `establishRoleControl`
 *  can send the first heartbeat immediately after a role opens, on the identical call `startHeartbeatLoop`
 *  below uses on every later tick. */
export async function heartbeatOnce(
  client: ControlClient,
  method: string,
  controlEpoch: number,
  heartbeatChallenge: string,
): Promise<{ nextHeartbeatChallenge: string }> {
  const params = controlHeartbeatParamsSchema.parse({ controlEpoch, heartbeatChallenge });
  const raw = await client.call(method, params, PROXY_CONTROL_RPC_TIMEOUT_MS);
  try {
    return controlHeartbeatResultSchema.parse(raw);
  } catch (error: unknown) {
    throw new HeartbeatReplyUndecodableError(error);
  }
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
  | Readonly<{ kind: 'in-flight'; challenge: string; attempt: symbol }>
  | Readonly<{ kind: 'stopped' }>;

export type HeartbeatFailureDisposition =
  | Readonly<{
      kind: 'retry';
      challenge: string;
      incidentReason: ProviderProxyHeartbeatIncidentReason;
    }>
  | Readonly<{ kind: 'terminal'; terminalReason: ProviderProxyHeartbeatTerminalReason; error: ControlClientError }>
  /** Not a disposition about the peer: this process could not construct or send the call at all. Retrying
   *  reproduces the identical failure, so a caller must treat this as decisive rather than folding it into a
   *  hold. */
  | Readonly<{ kind: 'local-failure'; error: unknown }>;

export function heartbeatFailureDisposition(error: unknown, challenge: string): HeartbeatFailureDisposition {
  if (error instanceof HeartbeatReplyUndecodableError) {
    return { kind: 'retry', challenge, incidentReason: 'unclassified' };
  }
  if (!(error instanceof ControlClientError)) {
    return { kind: 'local-failure', error };
  }
  const refusal = error.remoteFailure?.kind === 'json-rpc-error' ? error.remoteFailure.heartbeatRefusal : null;
  if (refusal?.reason === 'challenge-mismatch') {
    return {
      kind: 'retry',
      challenge: refusal.nextHeartbeatChallenge,
      incidentReason: 'challenge-resynchronized',
    };
  }
  if (refusal?.reason === 'teardown-latched') {
    return { kind: 'terminal', terminalReason: 'teardown-latched', error };
  }
  if (error.origin !== 'remote-response') {
    return { kind: 'retry', challenge, incidentReason: 'unanswered' };
  }
  return { kind: 'retry', challenge, incidentReason: 'unclassified' };
}

function startHeartbeatLoop(
  client: ControlClient,
  method: string,
  runtime: Runtime,
  controlEpoch: number,
  firstNextChallenge: string,
  onIncident: (error: unknown, reason: ProviderProxyHeartbeatIncidentReason) => void,
  onAccepted: () => void,
  onTerminal: (error: unknown, reason: ProviderProxyHeartbeatTerminalReason) => void,
): HeartbeatLoop {
  let state: HeartbeatLoopState = { kind: 'idle', challenge: firstNextChallenge };
  const tick = (): void => {
    if (state.kind !== 'idle') return;
    const { challenge } = state;
    const attempt = Symbol('provider-proxy-heartbeat');
    state = { kind: 'in-flight', challenge, attempt };
    void heartbeatOnce(client, method, controlEpoch, challenge).then(
      (beat) => {
        if (state.kind !== 'in-flight' || state.attempt !== attempt) return;
        state = { kind: 'idle', challenge: beat.nextHeartbeatChallenge };
        onAccepted();
      },
      (error: unknown) => {
        if (state.kind !== 'in-flight' || state.attempt !== attempt) return;
        const disposition = heartbeatFailureDisposition(error, challenge);
        if (disposition.kind === 'retry') {
          state = { kind: 'idle', challenge: disposition.challenge };
          onIncident(error, disposition.incidentReason);
          return;
        }
        state = { kind: 'stopped' };
        runtime.time.clearInterval(handle);
        // `local-failure` is not a peer disposition, but this loop still has only one way to stop and report a
        // decisive end — the same terminal path `teardown-latched` uses, distinguished by its own reason.
        onTerminal(disposition.error, disposition.kind === 'terminal' ? disposition.terminalReason : 'local-failure');
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
        (error, incidentReason) => {
          faults.reportIncident({ kind: 'heartbeat-indeterminate', role, method, incidentReason, error });
        },
        () => faults.reportIncident({ kind: 'heartbeat-accepted', role, method }),
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
