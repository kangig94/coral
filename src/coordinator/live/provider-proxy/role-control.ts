import type { z } from 'zod';

import { PROXY_CONTROL_RPC_TIMEOUT_MS } from '../../../provider-proxy/protocol.js';
import {
  connectRoleControlWithRetry,
  type RoleConnectRetryOptions,
  type runtimeControlTimer,
} from '../../../provider-proxy/role-spawn.js';
import type { ControlClient, ProviderEventHandler } from '../../../provider-proxy/control-client.js';
import { heartbeatOnce } from './heartbeat.js';

/** Compares only the fields this acquisition can independently verify — everything it minted, plus (for the
 *  guardian alone) the pid and start time the acquisition observed by spawning it itself. A disagreement here
 *  means the connected process is not the one this acquisition created. */
function assertIdentityFieldsAgree(
  role: string,
  expected: Readonly<Record<string, string | number>>,
  actual: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) {
      throw new Error(
        `${role} identity disagreement on ${key}: this acquisition issued ${String(value)}, the process reported ${String(actual[key])}.`,
      );
    }
  }
}

export type ControlTimer = ReturnType<typeof runtimeControlTimer>;

/** One role's connect→open→verify→heartbeat plan. `identity` pulls the role's own identity field out of the
 *  already-schema-validated open result — a selector rather than a `result[role]` lookup, so the compiler
 *  checks it against the concrete open-result type instead of trusting a string key at runtime. Exported so
 *  `services/provider-proxy-set-inheritance.ts` can describe its own redeem/rotate opens the same shape
 *  `establishRoleControl` already consumes, rather than a second, parallel plan type. */
export type RoleControlPlan<TOpened extends { controlEpoch: number; heartbeatChallenge: string }> = Readonly<{
  role: string;
  endpoint: string;
  openMethod: string;
  openParams: Record<string, unknown>;
  openResultSchema: z.ZodType<TOpened>;
  identity: (opened: TOpened) => Record<string, unknown>;
  heartbeatMethod: string;
  expectedIdentity: Readonly<Record<string, string | number>>;
  /** Only the proxy role ever pushes `provider.event.v1` back over this connection (`protocol.ts`'s own
   *  doc), so only the proxy's plan supplies this. */
  onProviderEvent?: ProviderEventHandler;
}>;

/**
 * Connects one role's control endpoint, opens it, verifies the identity it reports against what this
 * acquisition expects, and sends the first heartbeat — the sequence every one of the three roles goes
 * through in the same order, differing only in which method/params/schema/expected-identity apply.
 *
 * `opened` is mutated (the connected client is pushed the moment it exists, before anything can fail) so the
 * caller's own try/catch can still close every role connected so far, including this one, on a later
 * failure — the same close-everything-opened behavior a single inline try/catch gave when this was one block
 * per role instead of one shared function.
 *
 * Exported: `services/provider-proxy-set-inheritance.ts` drives the identical connect→open→verify→heartbeat
 * sequence for a redeemed tenancy (`guardian.handoff-redeem.v1`, `reaper.handoff-rotate.v1`,
 * `handoff.redeem.v1`) that `acquisition-steps.ts` drives for a freshly minted one — the opening credential
 * differs, the mechanics do not, so there is exactly one function that dials a role and keeps its first
 * challenge alive.
 */
export async function establishRoleControl<TOpened extends { controlEpoch: number; heartbeatChallenge: string }>(
  opened: ControlClient[],
  timer: ControlTimer,
  retry: RoleConnectRetryOptions,
  plan: RoleControlPlan<TOpened>,
): Promise<Readonly<{ client: ControlClient; opened: TOpened; nextHeartbeatChallenge: string }>> {
  const client = await connectRoleControlWithRetry(plan.endpoint, timer, retry, plan.onProviderEvent);
  opened.push(client);
  const raw = await client.call(plan.openMethod, plan.openParams, PROXY_CONTROL_RPC_TIMEOUT_MS);
  const result = plan.openResultSchema.parse(raw);
  assertIdentityFieldsAgree(plan.role, plan.expectedIdentity, plan.identity(result));
  const beat = await heartbeatOnce(client, plan.heartbeatMethod, result.controlEpoch, result.heartbeatChallenge);
  return { client, opened: result, nextHeartbeatChallenge: beat.nextHeartbeatChallenge };
}
