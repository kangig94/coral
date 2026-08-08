import { PROXY_CONTROL_HEARTBEAT_MS } from '../../../provider-proxy/orphan-deadline.js';
import {
  PROXY_CONTROL_RPC_TIMEOUT_MS,
  controlHeartbeatParamsSchema,
  controlHeartbeatResultSchema,
} from '../../../provider-proxy/protocol.js';
import type { Runtime } from '../../../runtime/ports.js';
import type { ControlClient } from '../../../provider-proxy/control-client.js';

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

/** Keeps one established tenancy alive past its lease by echoing the challenge on the endpoint's own
 *  heartbeat interval. A failed echo is handed to `onError` and not retried early — every production caller
 *  logs it, so a degrading tenancy is visible before its deadline fires, and the enforcer's own deadline,
 *  not this loop, is what bounds the fallout of one that cannot be refreshed. Exported so
 *  `services/provider-proxy-set-inheritance.ts` keeps a redeemed tenancy alive the identical way a freshly
 *  established one is kept alive here — one heartbeat mechanism, not two. */
export function startHeartbeatLoop(
  client: ControlClient,
  method: string,
  runtime: Runtime,
  controlEpoch: number,
  firstNextChallenge: string,
  onError: (error: unknown) => void,
): HeartbeatLoop {
  let challenge = firstNextChallenge;
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const beat = await heartbeatOnce(client, method, controlEpoch, challenge);
      challenge = beat.nextHeartbeatChallenge;
    } catch (error: unknown) {
      onError(error);
    }
  };
  const handle = runtime.time.setInterval(() => {
    void tick();
  }, PROXY_CONTROL_HEARTBEAT_MS);
  handle.unref?.();
  return {
    stop: () => {
      stopped = true;
      runtime.time.clearInterval(handle);
    },
  };
}
