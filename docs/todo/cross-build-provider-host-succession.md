# TODO — transfer live provider execution hosts across builds

**Status**: open. Phase 6 of the upgrade-escalation plan (AC14) is still owed.

A provider host's provenance stays tied to the build that launched it. `classifyProviderProxySetInheritance` in `src/coordinator/services/provider-proxy-set/inheritance.ts` and `assertNamedCoordinatorBuild` in `src/provider-proxy/proxy.ts` still reject a different build as controller. Coordinator-local app-server execution also ends with the coordinator. Until a compatible host can transfer, its owner reports `blocking`; the incumbent keeps serving and its durable upgrade intent remains visible.

Add an authenticated, versioned controller-transfer protocol for guardian, reaper, and proxy hosts. The current controller must issue a receipt for the successor's accepted generation; the host must persist an attempt-scoped recovery grant before fencing the old controller. Transfer operation membership, output replay, cancellation, and terminal acknowledgement without relaunching the work. A failed attempt must return one controller, including after one host acknowledges but before `serving` is recorded. Retain each host's whole original plugin root while it runs. Replace coordinator-local execution with an independent host where continuity is required.

The same-build capsule gate must be replaced by receipt authority, not bypassed. Legacy or incompatible hosts remain blockers and follow the existing deferred path. Publish the host-transfer behavior and protocol documentation before the Phase 6 release.

## Start condition

Use the Phase 6 AC14 matrix in the upgrade-escalation plan: live output and cancellation across transfer, lost acknowledgement, host provenance, controller fencing, recovery grant, and mixed-build process tests.
