// Vitest threads pool registers SIGTERM/SIGINT handlers per test file in the
// same worker. With 60+ files this exceeds Node's default limit of 10. These
// handlers are cleaned up normally — raise the limit to suppress the warning.
process.setMaxListeners(100);

// Hermetic env baseline: scrub the KB-control variables a developer may export
// in their shell (e.g. `CORAL_KB_ENABLE=0` to pause local curate, or a custom
// `CORAL_KB_PATH`). Inherited, they would flip the KB-default-enabled behavior
// inside every worker and silently break KB/hook/startup tests that assume the
// default. Tests that exercise these flags set them explicitly (vi.stubEnv or a
// subprocess env), so removing the ambient values cannot mask intended setups.
for (const key of ['CORAL_KB_ENABLE', 'CORAL_KB_PATH']) {
  delete process.env[key];
}

// `__PLUGIN_ROOT__` is an esbuild-injected build-time constant in production
// bundles. Tests run from source so it is not naturally defined; provide the
// repository root as the test value so modules that reference it (e.g.
// claude broker entrypoint resolver) can run without bundle-only stubs.
(globalThis as unknown as { __PLUGIN_ROOT__: string }).__PLUGIN_ROOT__ = process.cwd();
