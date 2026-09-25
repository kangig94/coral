import { runUpgradeWaiter } from './index.js';
import { socketPathForRunDir } from '../infra/path/index.js';
import { readUpgradeIntent } from '../infra/upgrade-intent.js';

const [runDir, socketPath, targetRoot] = process.argv.slice(2);
if (runDir === undefined || socketPath === undefined || targetRoot === undefined) {
  process.exitCode = 2;
} else {
  const observed = readUpgradeIntent(runDir);
  const addressedSocket =
    socketPath ||
    (observed.kind === 'readable'
      ? socketPathForRunDir(runDir, observed.intent.incumbent.flavor, { platform: process.platform })
      : null);
  if (addressedSocket === null) process.exitCode = 1;
  else
    void runUpgradeWaiter({ runDir, socketPath: addressedSocket, targetRoot }).then(
      (result) => {
        process.exitCode = result.kind === 'unobservable' ? 1 : 0;
      },
      () => {
        process.exitCode = 1;
      },
    );
}
