// Vitest threads pool registers SIGTERM/SIGINT handlers per test file in the
// same worker. With 60+ files this exceeds Node's default limit of 10. These
// handlers are cleaned up normally — raise the limit to suppress the warning.
process.setMaxListeners(100);

// `__PLUGIN_ROOT__` is an esbuild-injected build-time constant in production
// bundles. Tests run from source so it is not naturally defined; provide the
// repository root as the test value so modules that reference it (e.g.
// claude broker entrypoint resolver) can run without bundle-only stubs.
(globalThis as unknown as { __PLUGIN_ROOT__: string }).__PLUGIN_ROOT__ = process.cwd();
