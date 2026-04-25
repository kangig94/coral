export type BuildFlavor = 'prod' | 'dev';

export function resolveBuildFlavor(env: NodeJS.ProcessEnv): BuildFlavor {
  return env.CORAL_FLAVOR === 'dev' ? 'dev' : 'prod';
}
