/**
 * The bundle directory an e2e test executes. There is deliberately no default: `clients/build` and
 * `clients/bridge` hold different builds — the latter is rebuilt only by the Release workflow, so on
 * `main` between releases it is the previous release — and a test that guesses will assert source
 * behaviour against whichever bundle it happened to pick. A suite may only run with the variable set.
 */
export function e2eBundleDir(): string {
  const dir = process.env.CORAL_E2E_BUNDLE_DIR;
  if (!dir) {
    throw new Error(
      'CORAL_E2E_BUNDLE_DIR must identify the executing bundle directory. Run this suite through `npm run test:e2e:build` or `npm run test:e2e:release`.',
    );
  }
  return dir;
}
