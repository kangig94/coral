import { incarnationMayAuthorizeSignal, type ProcessIncarnation } from '../../../infra/node-process.js';
import { ABSENCE_POLL_MS } from '../../../infra/process-containment.js';
import type { Runtime } from '../../../runtime/ports.js';
import { PROXY_TEARDOWN_RESERVE_MS } from '../../../provider-proxy/orphan-deadline.js';
import type { SpawnedRoleProcess } from '../../../provider-proxy/role-spawn.js';

/**
 * The guardian's own acquisition-time undo: SIGTERM to the whole group, gated on the pid this acquisition
 * observed still being the process it spawned.
 *
 * The guardian is spawned `detached: true`, so it is its own process-group leader, and it in turn spawns the
 * reaper into that same group before the coordinator ever holds control on either — so this signals the whole
 * group via the negative-pid convention, not the guardian's own bare pid alone, or the reaper it already
 * spawned outlives it.
 *
 * SIGTERM here is what `role-main.ts`'s own shutdown handler treats as "give up": the guardian — and the
 * reaper right alongside it, since they share this one process group — drives its own enforcer's
 * `stopAndReap` on the detached, out-of-group proxy containment it holds before it exits, rather than merely
 * disarming and leaving that live leader held by no one. Whoever creates a thing holds it: the coordinator
 * created only the guardian, so its own undo can reach only the guardian's group directly, but asking the
 * guardian to give up is what makes it reap the reaper and proxy it created in turn, rather than the
 * coordinator having to reach across a boundary it has no standing to reach across itself.
 *
 * That reap can legitimately spend the same SIGTERM/SIGKILL grace and disappearance-confirmation budget any
 * other teardown does (`PROXY_TEARDOWN_RESERVE_MS`), so this waits that same floor for the group's own
 * disappearance before escalating to SIGKILL — a shorter fixed grace (`gracefulKillByPid`'s, built for a
 * plain child with nothing of its own left to do) would force-kill the guardian mid-reap and strand the very
 * containment it was just asked to hold.
 *
 * And a pid is not an identity on its own: the OS recycles it. This re-reads the pid's incarnation
 * immediately before signalling and refuses if it no longer matches what this acquisition recorded at spawn
 * time — signalling a mismatched pid would kill whatever unrelated process now holds it, which is the
 * project's BLOCKING process rule.
 */
export function buildGuardianSpawnUndo(
  runtime: Runtime,
  spawned: SpawnedRoleProcess,
  platform: NodeJS.Platform,
  readProcessIncarnation: (pid: number, platform: NodeJS.Platform) => ProcessIncarnation | null,
): () => Promise<void> {
  return async () => {
    // The same rule the reap paths apply: where an incarnation cannot authorize a signal, a match proves
    // nothing and this declines rather than guessing. Declining is affordable here and only here because the
    // guardian this undo would signal never received control, so its own orphan deadline ends it and the
    // reaper it holds along with it. Signalling a recycled pid is not affordable anywhere.
    if (!incarnationMayAuthorizeSignal(platform)) return;
    if (readProcessIncarnation(spawned.pid, platform) !== spawned.incarnation) return;
    const group = -spawned.pid;
    runtime.process.kill(group, 'SIGTERM');
    const graceDeadline = runtime.time.now() + PROXY_TEARDOWN_RESERVE_MS;
    while (runtime.process.observeLiveness(group) !== 'absent' && runtime.time.now() < graceDeadline) {
      await runtime.time.sleep(ABSENCE_POLL_MS);
    }
    if (runtime.process.observeLiveness(group) !== 'absent') {
      runtime.process.kill(group, 'SIGKILL');
    }
  };
}
