import { claimCoordinatorLaunch } from '#src/infra/coordinator-admission.js';

if (process.env.CORAL_FIXTURE_FREEZE_PHASE === 'before-admission') setInterval(() => {}, 60_000);
else
  void claimCoordinatorLaunch().then((admitted) => {
    if (!admitted) {
      process.exitCode = 1;
      return;
    }
    setInterval(() => {}, 60_000);
  });
