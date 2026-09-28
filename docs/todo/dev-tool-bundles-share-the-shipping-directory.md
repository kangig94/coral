# TODO — stage developer bundles outside the shipping directory

**Status**: open. The build allowlist has grown with the sentinel, durable wrapper, and succession files; it still rejects developer-tool output.

`scripts/run-simulation.mjs` writes `clients/build/coral-simulation.cjs`. `scripts/capture-discuss-golden-master.mjs` writes `simulation-core.mjs` and `discuss-golden-helpers.mjs` under the same build root. `scripts/build-server.mjs` runs `scripts/verify-kiwi-runtime-build-contract.mjs`, whose `expectedBuildFiles` allowlist rejects each of those names. The build does not clear these developer artifacts first, so running either tool can make the next build fail for staging state rather than source.

The exact allowlist protects what ships. Move the two tools' temporary bundles to paths outside `clients/build/` and make their cleanup explicit. The tools may share a scratch convention, but the shipping directory must contain only its declared bundle artifacts and optional receipt.

## Start condition

Choose a scratch location for developer bundles, then update both tools and the paths of the processes they launch. Preserve the build verifier's unexpected-file refusal.
