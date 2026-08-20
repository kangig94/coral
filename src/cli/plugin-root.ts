declare const __PLUGIN_ROOT__: string;

/**
 * In production bundles `__PLUGIN_ROOT__` is injected by esbuild at build time.
 *
 * Lives in its own module so CLI helpers share one resolver instead of
 * each capturing the values at module load.
 */
export function resolvePluginRoot(): string | undefined {
  if (typeof __PLUGIN_ROOT__ === 'string' && __PLUGIN_ROOT__.length > 0) {
    return __PLUGIN_ROOT__;
  }
  const fromEnv = process.env.CLAUDE_PLUGIN_ROOT;
  return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
}
