# TODO — a capsule this build cannot inherit is represented forever

**Status**: open. Deliberately deferred on `refactor/process-incarnation-token` after the harm was removed
and the residue was not.

## What exists now

A discovered handoff capsule this build may not act on — written by another build, or carrying a process
identity in the seconds V2 shipped with — takes a `capsule-foreign` slot
(`src/coordinator/services/provider-proxy-set/index.ts`). The slot holds an address, a path and a reason, and
nothing else: no timer, no attempt, no authority. It exists so the address stays represented and cannot be
aliased.

The reason it is not dialed is not tidiness. `handoff.redeem` is build-gated at the role
(`assertNamedCoordinatorBuild`, `src/provider-proxy/protocol.ts`), so a foreign set answers
`identity_mismatch`; the recovery policy reads that as `refused`, and `refused` retires _fatally_ before any
seam can weigh the absence evidence gathered beside it. Dialing one takes the coordinator down over a set it
never owned.

## What was fixed, and what was not

**Fixed**: a foreign slot no longer consumes acquisition capacity. It is excluded from the four-slot admission
count and from retained/excess classification. Before that, four capsules left by another build denied every
fresh proxy-set acquisition permanently, and one denied the matching host.

**Not fixed**: nothing retires the capsule file. Discovery rereads every matching file on each boot, so a
foreign capsule is rediscovered and warned about again, forever. The cost per capsule is now one map entry,
two alias-map entries and one log line per boot — real, bounded, and no longer able to deny service.

An earlier revision of this argument claimed the residue matched what stale V1 capsules already cost. That was
wrong and is worth recording: a same-build V1 becomes `capsule-opaque`, which consumes capacity, starts
redemption immediately and owns retry timers. It is not the same thing.

## The shape of the fix

A dead pid is dead regardless of identity, and that is the one observation available here. A foreign capsule
carries `guardianPid`, `reaperPid` and `proxyPid` in every version that has them, so absence is provable
without redeeming anything and without ever signalling: if none of the three is alive, the set is gone and the
file can be retired through the `capsule-retirement` producer the lifecycle already dispatches.

Three things stand in the way, and they are why this is a change rather than a patch:

1. `ProviderProxySetLifecycleDeps` has no process port. It would need one, and it is a required dep, so every
   construction site — production plus roughly a dozen test harnesses — states it.
2. The `capsule-foreign` slot deliberately keeps no capsule binding. Retirement by pid needs the pids, so the
   slot grows a field, which is the first thing that makes it more than an address.
3. Retirement is a recovery turn. The rewrite path shows the shape (`#rewriteOpaqueCapsule`), but a foreign
   capsule needs observe-then-retire rather than a single producer.

**Never signal.** A foreign capsule's processes belong to a build this one has no authority over; the pids may
only be _observed_. Absence is the sole conclusion this path may draw.

## Also here

`#rewriteOpaqueCapsule` upgrades a V1 capsule in place and writes V3 bytes at the V1 filename — the one name
an older build will open and refuse to start on (see `providerHandoffCapsulePath`). Reaching it needs a
same-build V1 capsule, and V1 predates this build's format by two generations, so no such capsule can exist.
It is left because the correct fix is a second recovery turn — write at the current generation, retire the
old name — which is the same machinery this document is about.

## Explicitly out of scope

The build gate itself, the capsule format, and `capsule-opaque`'s own lifetime. `capsule-opaque` is a
terminating path — it exists for V1 capsules that will age out of the field — and deleting it is a separate
decision.

## Start condition

None. The disposition is decided; what remains is the process port, the slot field and the observe-then-retire
turn. The test that pins it: install a foreign capsule whose recorded pids are all absent, and assert the file
is retired and the slot dropped — plus one whose pids are alive, and assert neither happens and nothing is
signalled.
