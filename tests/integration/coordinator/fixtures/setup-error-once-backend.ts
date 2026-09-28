import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runBackendMain } from '#src/coordinator/bootstrap.js';
import { writeStartupErrorSentinel } from '#src/coordinator/bootstrap-diagnostics.js';
import { claimCoordinatorLaunch } from '#src/infra/coordinator-admission.js';
import { CoralSetupError } from '#src/runtime/errors.js';

declare const __PLUGIN_ROOT__: string;

void claimCoordinatorLaunch().then((admitted) => {
  if (!admitted) {
    process.exitCode = 1;
    return;
  }
  const runDir = process.env.CORAL_SENTINEL_RUN_DIR;
  if (runDir !== undefined) {
    const marker = join(runDir, 'setup-error-once.fixture');
    if (!existsSync(marker)) {
      writeFileSync(marker, 'failed first child\n');
      writeStartupErrorSentinel(
        __PLUGIN_ROOT__,
        new CoralSetupError({
          code: 'startup_not_ready',
          userMessage: 'First fixture child failed.',
          remediation: 'Wait for supervisor recovery.',
        }),
        undefined,
      );
      process.exitCode = 1;
      return;
    }
  }
  void runBackendMain();
});
