# TODO — drop the legacy `coral-cli.cjs` bundle name at 0.11.0

**Status**: open. Do it in the release that moves the version to 0.11.0, not before.

## What is kept, and why

The CLI bundle ships as `bridge/coral-cli`: extensionless and executable, so the bundle directory can sit on
`PATH` and the file answers as the `coral-cli` command. Builds through 0.10.x know the CLI only as
`bridge/coral-cli.cjs`:

- Cross-version handoff (`src/infra/handoff-target.ts` in those builds) hashes the target bundle's
  `coral-cli.cjs` against the manifest and then launches it. Without the file an older CLI refuses the
  handoff to a newer backend.
- Active-store coordination (`src/store/active-store-selection-coordination.ts` in those builds, and the
  v0.10.9 v1-selection reader) validates a newer build's selection through the same hash. Without the file an
  older build treats the newer selection as invalid, re-publishes its own, and opens the store itself — two
  live builds then keep taking the selection from each other.

So every 0.10.x release also ships `bridge/coral-cli.cjs`, a byte-identical copy of `bridge/coral-cli`
(`LEGACY_CLI_BUNDLE_FILE` in `src/infra/bundle-manifest-address.ts`). Both hash to the manifest's
`cliBundleHash`, so both validations pass.

## Removal

At 0.11.0, delete `LEGACY_CLI_BUNDLE_FILE` and every place that copies, chmods, lists, or verifies it
(`scripts/build-server.mjs`, `scripts/verify-kiwi-runtime-build-contract.mjs`,
`scripts/verify-store-reset-build-contract.mjs`, `package.json` `files`, `.gitattributes`). A 0.10.x build
still running when 0.11.0 is installed then meets the failure above; the minor version bump is the point at
which that is accepted.
