import { join } from 'node:path';

import { beforeEach } from 'vitest';

{
  const home = process.env.CORAL_TEST_HOME;
  if (home === undefined || process.env.HOME !== home || process.env.USERPROFILE !== home) {
    throw new Error('Every test tier requires an isolated HOME from vitest/isolated-unit-home.ts.');
  }
}

declare module 'vitest' {
  interface TaskMeta {
    timeout?: number;
  }
}

// The JSON report carries durations and never budgets, so the budget rides on the task's own meta; a
// case without it is one the headroom gate could not judge (see casesWithoutHeadroom in
// scripts/test-report.mjs).
beforeEach((ctx) => {
  ctx.task.meta.timeout = ctx.task.timeout;
});

// Shared workers must raise the listener ceiling for Vitest's per-file signal handlers.
process.setMaxListeners(100);

// Hermetic env baseline: scrub the KB-control variables a developer may export
// in their shell (e.g. `CORAL_KB_ENABLE=0` to pause local curate, a custom
// `CORAL_KB_PATH`, or `CORAL_KB_EXTRA_LANGS=ko` for local Korean morphology).
// Inherited, they would flip the KB-default-enabled behavior or activate Kiwi
// inside every worker and silently break KB/hook/startup/Orama tests that
// assume the Intl-only baseline. Tests that exercise these flags set them
// explicitly (vi.stubEnv, withKoEnv, or a subprocess env), so removing the
// ambient values cannot mask intended setups.
for (const key of ['CORAL_KB_ENABLE', 'CORAL_KB_PATH', 'CORAL_KB_EXTRA_LANGS']) {
  delete process.env[key];
}

// The runner may itself be a Coral child. Its principal must never authenticate fixture commands.
// Cases that exercise child authentication install their own credentials after this baseline.
for (const key of [
  'CORAL_CHILD',
  'CORAL_CHILD_PRINCIPAL_HANDLE',
  'CORAL_CHILD_CREDENTIAL_ID',
  'CORAL_CHILD_CREDENTIAL_KEY',
  'CORAL_JOB_ID',
  'CORAL_SESSION_ID',
]) {
  delete process.env[key];
}

// `__PLUGIN_ROOT__` is an esbuild-injected build-time constant in production
// bundles, where it resolves to the plugin root that holds bridge/, inject/,
// methods/, and agents/ — i.e. clients/ in this repo (installs flatten that
// level away). Tests run from source so it is not naturally defined; point it
// at clients/ so modules that reference it (inject bundle resolver, claude broker
// entrypoint) find the real plugin surface.
(globalThis as unknown as { __PLUGIN_ROOT__: string }).__PLUGIN_ROOT__ = join(process.cwd(), 'clients');
