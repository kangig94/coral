import { backendLog } from '../../../infra/backend-log.js';
import { errorMessage } from '../../../infra/error-format.js';
import { PROXY_CONTROL_HEARTBEAT_MS } from '../../../provider-proxy/orphan-deadline.js';
import {
  PROXY_CONTROL_RPC_TIMEOUT_MS,
  controlHeartbeatParamsSchema,
  controlHeartbeatResultSchema,
} from '../../../provider-proxy/protocol.js';
import type { Runtime } from '../../../runtime/ports.js';
import type { ControlClient } from '../../../provider-proxy/control-client.js';
import type {
  ProviderProxyAuthorityFaultLatch,
  ProviderProxyHeartbeatMethod,
  ProviderProxyRole,
} from '../../services/provider-proxy-authority-fault.js';

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
  return controlHeartbeatResultSchema.parse(raw);
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

/** Keeps one established tenancy alive past its lease by echoing the challenge on the endpoint's own
 *  heartbeat interval. A failed echo is handed to `onError` and not retried early — every production caller
 *  logs it, so a degrading tenancy is visible before its deadline fires, and the enforcer's own deadline,
 *  not this loop, is what bounds the fallout of one that cannot be refreshed. Exported so
 *  `services/provider-proxy-set-inheritance.ts` keeps a redeemed tenancy alive the identical way a freshly
 *  established one is kept alive here — one heartbeat mechanism, not two. */
function startHeartbeatLoop(
  client: ControlClient,
  method: string,
  runtime: Runtime,
  controlEpoch: number,
  firstNextChallenge: string,
  onError: (error: unknown) => void,
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
      },
      (error: unknown) => {
        if (state.kind !== 'in-flight' || state.attempt !== attempt) return;
        state = { kind: 'stopped' };
        runtime.time.clearInterval(handle);
        onError(error);
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
        (error) => {
          faults.latch({ kind: 'heartbeat-failed', role, method, error });
          backendLog.warn(
            `provider-proxy ${role} heartbeat echo failed for ${session.instanceId}: ${errorMessage(error)}`,
          );
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
