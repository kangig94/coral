export type BuildFlavor = 'prod' | 'dev';

export function resolveBuildFlavor(env: NodeJS.ProcessEnv): BuildFlavor {
  return env.CORAL_FLAVOR === 'dev' ? 'dev' : 'prod';
}

let _buildFlavor: BuildFlavor = 'prod';
let _settledBuildFlavor: BuildFlavor | null = null;

export function setBuildFlavor(flavor: BuildFlavor): void {
  if (_settledBuildFlavor !== null) {
    if (_settledBuildFlavor !== flavor) {
      throw new Error(`Build flavor already set to ${_settledBuildFlavor}; cannot change to ${flavor}`);
    }
    return;
  }
  _settledBuildFlavor = flavor;
  _buildFlavor = flavor;
}

export function currentBuildFlavor(): BuildFlavor {
  return _buildFlavor;
}

export function getSettledBuildFlavor(): BuildFlavor | null {
  return _settledBuildFlavor;
}
