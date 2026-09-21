# An explicit drain can wait behind the pre-sequence in-flight gate forever

**Status**: open. Removing the gate is an owner decision, not a reporting change.

## What is wrong

`IdleTimer.tryDrain` (`src/coordinator/live/idle.ts`) does not start an explicitly requested drain while any
request remains in flight. The shutdown sequence later owns a bounded in-flight-drain obligation, so the
pre-sequence gate duplicates that wait without creating a ledger or a deadline. A long unary request or live
subscription can therefore keep `backend shutdown` before the sequence for as long as that request lives.

Removing the gate would let the existing sequence own the wait, but it would also allow the drain budget to
cut off a long request or subscription. That is a behavior decision this reporting branch does not take.

## Start condition

Start from a reproduced owner-1 absent-schedule status: `kernel.phase=running`, `inflightRequests > 0`, and no
live drain schedule. `backend status` must continue to report that there is no bound for this wait while the
owner decides whether explicit drains bypass the gate; do not replace the missing exit with an instruction
for a person who is not present.
