import { composeCoralPaths } from '#src/infra/path/compose.js';
import type { BuildFlavor } from '#src/infra/build-flavor.js';
import type { Runtime } from '#src/runtime/ports.js';

export function createFixtureRuntime(
  coralBaseDir: string,
  flavor: BuildFlavor = 'prod',
): Pick<Runtime, 'paths'> {
  return {
    paths: {
      projectSource: () => '',
      coral: composeCoralPaths(flavor, { baseDir: coralBaseDir }),
    },
  };
}
