export const CURRENT_STRICT_BUNDLE_MANIFEST_GENERATION = 2 as const;

export const CURRENT_STRICT_BUNDLE_MANIFEST_FILE =
  `manifest.v${CURRENT_STRICT_BUNDLE_MANIFEST_GENERATION}.json` as const;

/**
 * The CLI bundle's file name inside the bundle directory. Extensionless so the bundle directory can
 * sit on PATH and the file answers as the `coral-cli` command itself.
 */
export const CLI_BUNDLE_FILE = 'coral-cli' as const;

/**
 * A byte-identical copy of {@link CLI_BUNDLE_FILE}. Builds through 0.10.x validate and launch the CLI of a
 * newer bundle under this name; without it they refuse the handoff and re-publish their own store
 * selection over the newer build's. Remove at 0.11.0 — docs/todo/legacy-cli-bundle-name.md.
 */
export const LEGACY_CLI_BUNDLE_FILE = 'coral-cli.cjs' as const;
