# Shipped release fixture inventory

The fixture helper extracts the tagged `clients/` tree without rewriting its bridge or manifests. The fingerprints below come from each tag's `clients/bridge/manifest.json`; they require **three** frozen readers for the supported shipped releases.

| Tags | Store-format fingerprint | Relevant protocol and plugin shape |
| --- | --- | --- |
| v0.10.0 | `sha256:f14ec2988abbf0fe125a6b0c9b50cbece7104d8a82a96da149392e2f44e53f52` | Legacy manifest omits version and build hashes. IPC replacement compares exact incumbent identity and reports `processStartedAt`. CLI `ensure` can request replacement shutdown. |
| v0.10.1–v0.10.3 | `sha256:f14ec2988abbf0fe125a6b0c9b50cbece7104d8a82a96da149392e2f44e53f52` | Manifest adds version and build hashes; exact-match IPC replacement and CLI-initiated replacement remain. |
| v0.10.4 | `sha256:f14ec2988abbf0fe125a6b0c9b50cbece7104d8a82a96da149392e2f44e53f52` | CLI replacement moves to `prepareTopLevelSpawn` → `requestIncompatibleIncumbentHandoff`; behavior remains destructive on incompatible identity. |
| v0.10.5–v0.10.8 | `sha256:9fd970cdcb803f517d77b133bba86ae83ef1ff662f77da8656604f32c8e67980` | IPC replacement uses version precedence only within the same namespace; separately rooted plugins have different namespaces and still attempt shutdown. CLI `prepareTopLevelSpawn` only waits for administrative drain. Incumbent identity still uses `processStartedAt`. |
| v0.10.9 | `sha256:9fd970cdcb803f517d77b133bba86ae83ef1ff662f77da8656604f32c8e67980` | Incumbent identity changes to process `incarnation`. |
| v0.10.10–v0.10.12 | `sha256:ca97b533a127b1475b45a487793ab7183ae70620894d1ca36e193431065b2521` | `manifest.v2.json` and the durable wrapper appear; IPC `transport.shutdown` is registered in the operational RPC catalog. |
| v0.10.13 | `sha256:ca97b533a127b1475b45a487793ab7183ae70620894d1ca36e193431065b2521` | Adds the executable `bridge/coral-cli` and `bridge/package.json` beside `coral-cli.cjs`. |

Every tag's replacement caller recognizes the `shutdown_unauthorized` IPC error. The v0.10.9–v0.10.13 version-precedence check has the same cross-namespace limit as v0.10.5–v0.10.8. Every tag's `backend shutdown` command uses HTTP `/admin/shutdown`. The compatibility suites that consume these fixtures must exercise shipped contenders against new incumbents in starting, idle, busy, preparing, and committing states; the v0.10.0–v0.10.4 CLI replacement path; and direct upgrades from all three fingerprints. The complete materialization and startup matrix was removed during test pruning. The remaining `protected-epoch-shipped-sweep.test.ts` checks DB protection with v0.10.0 and v0.10.13.

## First release pairing window

The minimum supported predecessor remains **v0.10.0**. All fourteen tags remain in `SHIPPED_RELEASE_TAGS` and in the running-incumbent and idle-new-incumbent process rows of `version-pairing-matrix.test.ts`. The seven rows in that test's `SHIPPED_PROTOCOL_GROUPS` record the distinct replacement, CLI, identity, and plugin-shape behaviors above. `starting-handoff.test.ts` exercises one tag from each group through starting, idle, busy, preparing, and committing. The first release has no retired predecessor: a later release may remove a pair only when it records a higher minimum and adds a real-process soft-failure test for every retired behavior it can meet. The legacy CLI and rollback rows already verify that an older build encountering first-release state either keeps routing or serves after the selected newer root is invalidated, without taking a live address.

| Pairing or boundary | Real-process coverage |
| --- | --- |
| New contender → shipped running incumbent | `version-pairing-matrix.test.ts`, every tag; `consent-gate-shipped.test.ts` checks the v0.10.13 signal and intent boundary. |
| New contender → shipped starting or administratively draining incumbent | `version-pairing-matrix.test.ts`, one tag per store-format fingerprint. A test-only Node preload holds the tagged process at its IPC listening or close boundary without changing the shipped bundle. |
| New contender → shipped naturally retiring incumbent | `version-pairing-matrix.test.ts`, v0.10.0, v0.10.5, and v0.10.13, one per store-format fingerprint; each tagged CLI completes a job and the successor answers `jobs detail` for that id. |
| No-incumbent direct upgrade with completed and live or unresolved work | `version-pairing-matrix.test.ts`, one tag per fingerprint; a tagged process commits a completed job and accepts another job, then crashes. A later build must serve both ids through `jobs detail` after startup recovery or an evidence-backed hand-back. |
| Shipped contender and v0.10.0–v0.10.4 CLI → new incumbent | `version-pairing-matrix.test.ts`, every contender tag and every legacy CLI replacement tag, plus a real starting incumbent; `self-escalation-process.test.ts` adds busy process coverage, and `starting-handoff.test.ts` covers the five lifecycle responses by protocol group against an IPC test server. |
| Legacy CLI contender during new-to-new commit | `version-pairing-matrix.test.ts`, v0.10.0 and v0.10.4, the two destructive CLI call paths. |
| New-to-new deferred, prepared, committed | `self-escalation-process.test.ts`, `succession-commit-process.test.ts`, and `durable-cli-succession-process.test.ts`. |
| Rollback selection with a valid or invalid newer root | `version-pairing-matrix.test.ts`; v0.10.13 hands back to a still-valid newer root after its coordinator exits, then takes rollback in a separate isolated home only after that root is removed. |
| Retained addresses across shipped post-ready sweeps | `protected-epoch-shipped-sweep.test.ts`, v0.10.10–v0.10.13, the tags containing `reapPostReadyStoreEpochEntries`; v0.10.0 separately covers the legacy `store.db` startup and reset path. |

## Phase 6 pairing window

The first-release build is built from its pinned commit (`FIRST_RELEASE_REF` in `helpers.ts`) rather than from a tag, so these rows need the full history that CI already fetches. Hosts that predate controller succession answer the transfer methods with `method_not_found`; the pairings below prove that such a host stays with its incumbent and that only a compatible host moves.

| Pairing or boundary | Real-process coverage |
| --- | --- |
| Phase 6 contender → idle first-release incumbent | `version-pairing-matrix.test.ts`; the first-release build is a supported predecessor and the Phase 6 successor serves with a completed intent. |
| Phase 6 contender → first-release incumbent whose legacy host runs a job | `version-pairing-matrix.test.ts`; succession defers on the provider host owners, the incumbent keeps serving, and the job completes in the same host processes. |
| Phase 6 contender → v0.10.13 incumbent whose legacy host runs a job | `version-pairing-matrix.test.ts`; the shipped incumbent keeps serving and its host completes the job. |
| Compatible Phase 6 incumbent → Phase 6 contender with a live host | `provider-host-transfer-process.test.ts`; transfer at once through startup recovery with live output, cancellation through the successor, a lost serving acknowledgment, a successor that dies before serving, and a successor that declares no host control generation. |
