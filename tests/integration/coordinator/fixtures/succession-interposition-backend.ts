import { runBackendMain } from '#src/coordinator/bootstrap.js';
import { claimCoordinatorLaunch } from '#src/infra/coordinator-admission.js';
import { successionInterpositionFromEnvironment } from '#tests/fixtures/succession-interposition.js';

void claimCoordinatorLaunch().then((admitted) => {
  if (admitted) runBackendMain({ successionInterposition: successionInterpositionFromEnvironment() });
  else process.exitCode = 1;
});
