import { claimCoordinatorLaunch } from '../infra/coordinator-admission.js';

const utilityInvocation =
  process.argv.some((arg) =>
    [
      '--print-store-format-fingerprint',
      '--print-store-reset-build-identity',
      '--probe-retained-epoch',
      '--recover-retained-epoch',
      '--smoke-open-store',
      '--provider-guardian',
      '--provider-reaper',
      '--provider-proxy',
    ].includes(arg),
  ) || process.env.CORAL_KB_DAEMON === '1';

void (utilityInvocation ? Promise.resolve(true) : claimCoordinatorLaunch())
  .then(async (admitted) => {
    if (admitted) await import('../coordinator/bootstrap.js');
    else process.exitCode = 1;
  })
  .catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
