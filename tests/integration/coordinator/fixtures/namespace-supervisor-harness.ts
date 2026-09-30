import { runNamespaceSupervisor } from '#src/coordinator-launch/supervisor.js';
import { launchLegacyBackend } from '#src/coordinator-launch/legacy-bootstrap.js';
import type { ChildProcess } from 'node:child_process';
import { updateLaunchStatus } from '#src/infra/launch-status.js';
import { writeFileSync } from 'node:fs';

const executable = process.argv[2];
if (executable === '--launch-legacy') {
  const target = process.argv[3];
  if (target === undefined) throw new Error('Missing legacy backend');
  void launchLegacyBackend(target, process.argv.slice(4));
} else {
  const runDir = process.env.CORAL_SENTINEL_RUN_DIR;
  if (executable === undefined || runDir === undefined) throw new Error('Missing coordinator fixture or run directory');

  let coordinator: ChildProcess | null = null;
  let refusedKill = false;
  process.on('message', (message: unknown) => {
    if (message === 'fixture-status-hold')
      updateLaunchStatus(runDir, (status) => ({
        ...status,
        hold: { kind: 'custody-unreadable', path: '/fixture/custody', retry: 'restore-readable-custody-record' },
      }));
    if (message === 'disconnect-coordinator') coordinator?.disconnect();
    if (message === 'error-coordinator-channel') coordinator?.emit('error', new Error('IPC send failed'));
    if (typeof message === 'object' && message !== null && 'fixtureChildMessage' in message)
      coordinator?.emit('message', message.fixtureChildMessage);
  });
  void runNamespaceSupervisor(executable, [], runDir, {
    timing:
      process.env.CORAL_FIXTURE_REAL_BACKEND === '1'
        ? { challengeMs: 100, schedulingGapMs: 1_000, lapseMs: 8_000, graceMs: 200, dStateDeferralMs: 4_000 }
        : { challengeMs: 20, schedulingGapMs: 80, lapseMs: 300, graceMs: 80, dStateDeferralMs: 120 },
    startupBudgetMs: Number(process.env.CORAL_FIXTURE_STARTUP_BUDGET_MS ?? 25_000),
    onChild: (child) => {
      coordinator = child;
      if (process.env.CORAL_FIXTURE_CHILD_PID_PATH !== undefined && child.pid !== undefined)
        writeFileSync(process.env.CORAL_FIXTURE_CHILD_PID_PATH, String(child.pid));
      if (process.env.CORAL_FIXTURE_REFUSE_KILL_ONCE === '1' && !refusedKill) {
        const kill = child.kill.bind(child);
        child.kill = ((signal) => {
          if (signal === 'SIGKILL' && !refusedKill) {
            refusedKill = true;
            return false;
          }
          return kill(signal);
        }) as typeof child.kill;
      }
    },
  }).then((code) => {
    process.exitCode = code;
  });
}
