# TODO — verify and narrow the Darwin process-incarnation alias

**Status**: signal authority is implemented; the wall-clock alias in the Darwin probe remains.

`probeMacProcessIncarnation` in `src/infra/node-process.ts` runs `ps -o lstart=` and parses its local-time, second-resolution output. The boot-session UUID separates reboots, but a clock step can still make two processes started in one boot produce the same token if a pid is reused. The autumn daylight-saving fallback gives that alias a predictable one-hour window.

`incarnationMayAuthorizeSignal` in the same module permits recorded-token signal authority only on Linux. `reapRecordedContainment` in `src/infra/process-containment.ts` requires either that authority or an exact retained child handle before signalling; the Darwin token alone remains conservative observation, not permission to kill. Preserve this rule.

## Remaining work

On macOS, verify whether `TZ=UTC` changes `ps -o lstart=` to UTC. If it does, set that environment for `probeMacProcessIncarnation` and pin the result with a platform test. This removes the scheduled daylight-saving alias, while backward clock steps and one-second resolution remain. The existing fail-closed signal gate continues to cover those residual aliases; a native addon is outside this entry.
