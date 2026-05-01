declare const __PLUGIN_ROOT__: string;

/**
 * Resolves the Coral plugin install root for CLI processes. In production
 * bundles `__PLUGIN_ROOT__` is injected by esbuild at build time; for dev
 * runs (or the rare case it's missing) `CLAUDE_PLUGIN_ROOT` is honored as
 * an explicit override. Returns `undefined` when neither is available so
 * callers can decide whether to fall back further or fail.
 *
 * Lives in its own module so CLI helpers (dispatch, read-store, etc.)
 * share one resolver instead of each capturing the values at module load.
 */
export function resolvePluginRoot(): string | undefined {
  if (typeof __PLUGIN_ROOT__ === 'string' && __PLUGIN_ROOT__.length > 0) {
    return __PLUGIN_ROOT__;
  }
  const fromEnv = process.env.CLAUDE_PLUGIN_ROOT;
  return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
}
