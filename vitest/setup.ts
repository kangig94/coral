import { join } from 'node:path';

// Vitest registers SIGTERM/SIGINT handlers per test file in the
// same worker. With 60+ files this exceeds Node's default limit of 10. These
// handlers are cleaned up normally — raise the limit to suppress the warning.
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

// `__PLUGIN_ROOT__` is an esbuild-injected build-time constant in production
// bundles, where it resolves to the plugin root that holds bridge/, inject/,
// methods/, and agents/ — i.e. clients/ in this repo (installs flatten that
// level away). Tests run from source so it is not naturally defined; point it
// at clients/ so modules that reference it (inject bundle resolver, claude broker
// entrypoint) find the real plugin surface.
(globalThis as unknown as { __PLUGIN_ROOT__: string }).__PLUGIN_ROOT__ = join(process.cwd(), 'clients');
