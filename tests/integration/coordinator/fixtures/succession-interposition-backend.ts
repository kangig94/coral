import { runBackendMain } from '#src/coordinator/bootstrap.js';
import { claimCoordinatorLaunch } from '#src/infra/coordinator-admission.js';
import { successionInterpositionFromEnvironment } from '#tests/fixtures/succession-interposition.js';
import { appendFileSync } from 'node:fs';

process.on('SIGUSR2', () => {
  if (process.connected) process.disconnect();
});

void claimCoordinatorLaunch().then((admitted) => {
  if (admitted) {
    const successionInterposition = { ...successionInterpositionFromEnvironment() };
    const log = process.env.CORAL_FIXTURE_SUCCESSION_LOG;
    if (log !== undefined) {
      const at = successionInterposition.at;
      successionInterposition.at = async (...args) => {
        appendFileSync(
          log,
          JSON.stringify({ pid: process.pid, point: args[0], phase: 'enter', at: Date.now() }) + '\n',
        );
        await at(...args);
        appendFileSync(
          log,
          JSON.stringify({ pid: process.pid, point: args[0], phase: 'leave', at: Date.now() }) + '\n',
        );
      };
      process.on('exit', (code) =>
        appendFileSync(log, JSON.stringify({ pid: process.pid, exitCode: code, at: Date.now() }) + '\n'),
      );
    }
    runBackendMain({ successionInterposition });
  } else process.exitCode = 1;
});
