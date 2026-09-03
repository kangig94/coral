import { errorMessage } from '../../../infra/error-format.js';
import { incarnationMayAuthorizeSignal, type ProcessIncarnation } from '../../../infra/node-process.js';
import { ABSENCE_POLL_MS } from '../../../infra/process-containment.js';
import type { ControlClient, ControlExchange } from '../../../provider-proxy/control-client.js';
import { PROXY_TEARDOWN_RESERVE_MS } from '../../../provider-proxy/orphan-deadline.js';
import {
  guardianContainmentCommitParamsSchema,
  guardianContainmentCommitResultSchema,
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

export type GuardianSpawnUndo = (() => Promise<void>) &
  Readonly<{
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

  const run = async (): Promise<void> => {
    if (control !== null) {
      const established = control;
      try {
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
      } finally {
        established.client.close();
      }
      return;
    }

    // Before authenticated control exists, an identity-checked signal is the only request channel.
    if (!incarnationMayAuthorizeSignal(platform)) return;
    if (readProcessIncarnation(spawned.pid, platform) !== spawned.incarnation) return;
    const group = -spawned.pid;
    runtime.process.kill(group, 'SIGTERM');
    const deadline = runtime.time.now() + PROXY_TEARDOWN_RESERVE_MS;
    while (runtime.process.observeLiveness(group) !== 'absent' && runtime.time.now() < deadline) {
      await runtime.time.sleep(ABSENCE_POLL_MS);
    }
    if (runtime.process.observeLiveness(group) !== 'absent') {
      throw new Error('guardian process-group absence was not confirmed after SIGTERM');
    }
  };
  return Object.assign(run, {
    bindControl: (established: GuardianControlTeardown): void => {
      control = established;
    },
  });
}
