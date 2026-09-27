# TODO — legacy coordinators can still wedge without a supervisor

**Status:** current-build recovery is implemented. The remaining limitation belongs to coordinators already shipped without a sentinel.

Current coordinator launches run beneath `runtime/sentinel.ts`. Its private heartbeat detects a stopped event loop, tolerates a shared scheduling freeze, and ends only its own unreaped child after the ten-minute lapse and 30-second grace. A current coordinator whose sentinel pipe closes stops admitting and enters bounded shutdown. Unary request leases in `coordinator/live/request-leases.ts` prevent never-settling awaited work from keeping inflight ownership indefinitely.

Shipped v0.10.0–v0.10.13 coordinators cannot gain that parent after they start. If one stops answering while it holds the socket, the CLI observes it for 30 seconds and returns retryable `coordinator_recovering` with monitoring `unavailable` or `unknown`. Recovery still depends on its event loop resuming, its normal exit, or an external lifecycle owner. The CLI has no authority to kill it. Decide whether an external service manager is warranted for those retained builds; no in-process change can retrofit a parent to an already running process.

The 2026-08-23 observation that opened this entry was a coordinator blocked in Linux `D` state on an ext4 journal commit with `SIGKILL` pending. A signal delivered during that state cannot end the process until the kernel resumes the thread. The current sentinel resets its observation window when it sees `D` state instead of treating that delayed signal as confirmed death.
