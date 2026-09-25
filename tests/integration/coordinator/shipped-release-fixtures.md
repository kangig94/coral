# Shipped release fixture inventory

The fixture helper extracts the tagged `clients/` tree without rewriting its bridge or manifests. The fingerprints below come from each tag's `clients/bridge/manifest.json`; they require **three** frozen readers for the supported shipped releases.

| Tags | Store-format fingerprint | Relevant protocol and plugin shape |
| --- | --- | --- |
| v0.10.0 | `sha256:f14ec2988abbf0fe125a6b0c9b50cbece7104d8a82a96da149392e2f44e53f52` | Legacy manifest omits version and build hashes. IPC replacement compares exact incumbent identity and reports `processStartedAt`. CLI `ensure` can request replacement shutdown. |
| v0.10.1–v0.10.3 | `sha256:f14ec2988abbf0fe125a6b0c9b50cbece7104d8a82a96da149392e2f44e53f52` | Manifest adds version and build hashes; exact-match IPC replacement and CLI-initiated replacement remain. |
| v0.10.4 | `sha256:f14ec2988abbf0fe125a6b0c9b50cbece7104d8a82a96da149392e2f44e53f52` | CLI replacement moves to `prepareTopLevelSpawn` → `requestIncompatibleIncumbentHandoff`; behavior remains destructive on incompatible identity. |
| v0.10.5–v0.10.8 | `sha256:9fd970cdcb803f517d77b133bba86ae83ef1ff662f77da8656604f32c8e67980` | IPC replacement uses version precedence; CLI `prepareTopLevelSpawn` only waits for administrative drain. Incumbent identity still uses `processStartedAt`. |
| v0.10.9 | `sha256:9fd970cdcb803f517d77b133bba86ae83ef1ff662f77da8656604f32c8e67980` | Incumbent identity changes to process `incarnation`. |
| v0.10.10–v0.10.12 | `sha256:ca97b533a127b1475b45a487793ab7183ae70620894d1ca36e193431065b2521` | `manifest.v2.json` and the durable wrapper appear; IPC `transport.shutdown` is registered in the operational RPC catalog. |
| v0.10.13 | `sha256:ca97b533a127b1475b45a487793ab7183ae70620894d1ca36e193431065b2521` | Adds the executable `bridge/coral-cli` and `bridge/package.json` beside `coral-cli.cjs`. |

Every tag's replacement caller recognizes the `shutdown_unauthorized` IPC error. Every tag's `backend shutdown` command uses HTTP `/admin/shutdown`. The compatibility suites that consume these fixtures must exercise shipped contenders against new incumbents in starting, idle, busy, preparing, and committing states; the v0.10.0–v0.10.4 CLI replacement path; and direct upgrades from all three fingerprints. The tests in this file check that the complete shipped trees materialize and representatives of each fingerprint start from separate plugin roots.
