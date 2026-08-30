# TODO — two developer tools stage bundles where the build contract permits exactly four

**Status**: open, not started. Both halves are one-line reproductions; the decision is where the tools should
stage instead, and that is not obvious.

## What breaks

`scripts/verify-kiwi-runtime-build-contract.mjs` reads `clients/build/` and refuses any entry outside
`coral-backend.cjs`, `coral-cli.cjs`, `coral-claude-appserver.cjs`, `manifest.json`, plus an optional
`build-receipt.json`. `scripts/build-server.mjs` runs it as the last step of `npm run build`, so the refusal
is a build failure, not a warning.

Two developer tools write into that same directory:

- `scripts/run-simulation.mjs` esbuilds `clients/build/coral-simulation.cjs` before every `npm run simulate`.
- `scripts/capture-discuss-golden-master.mjs` esbuilds `clients/build/discuss-golden-helpers.mjs` and
  `clients/build/simulation-core.mjs`.

So `npm run simulate && npm run build` fails, and has always failed. `scripts/clean-dist.mjs` removes only
`dist/`, so nothing clears the residue; the next build fails until someone deletes the files by hand. The
error names the whole directory listing and blames WASM staging, which is what the contract was written to
catch, so the message points away from the actual cause.

Observed 2026-08-30 while verifying an unrelated branch: a build failed with
`Kiwi build contract expected the four bundle files … got: build-receipt.json, coral-backend.cjs,
coral-claude-appserver.cjs, coral-cli.cjs, coral-simulation.cjs, discuss-golden-helpers.mjs, manifest.json,
simulation-core.mjs`. Deleting the three extra files made the same build pass unchanged.

Observed 2026-08-31 through a second consumer of the directory: after `npm run simulate` wrote its bundle into
`clients/build/` and that staged artifact was deleted again, `npm run test:e2e:lifecycle` failed two tests
with `Error: clients/build is stale; run npm run build:dev`. Re-running `npm run build` cleared the failure,
and all five lifecycle tests passed. The suite's
`assertLifecycleBundleSetFresh` (`tests/support/bundle-build-freshness.ts`) checks the receipt and shipping
outputs in that same directory, so the blast radius is not limited to the Kiwi exact-set contract. Anyone
running the full gate by hand must run `npm run simulate` after `test:e2e:lifecycle`; otherwise the lifecycle
suite can fail for staging state rather than for the code under test.

## Why the contract is not the thing to loosen

The exact-set check is the point. It exists so a staged Kiwi WASM artifact beside the bundles cannot ship, and
an allowlist that grows one dev-tool entry at a time stops being a contract. Widening it to ignore
`*-simulation.cjs` and `*-helpers.mjs` would let the next tool's artifact through silently.

## Required shape

The shipping directory holds what ships. A developer tool that needs a bundle stages it somewhere that is not
`clients/build/` — a sibling scratch directory, or the system temp root the test suites already use — and
removes it or leaves it outside any contract's view. Whatever is chosen, the same choice covers both tools,
because two tools staging in two different private places is the same problem one directory over.

Out of scope: making the contract's message name the offending entries. That is worth doing and is not this
entry; the message is only misleading while the residue exists.

## Start condition

Startable now. The decision needed first is whether Coral has a general answer for "a developer tool needs a
build artifact" or whether these two tools each get a private path.
