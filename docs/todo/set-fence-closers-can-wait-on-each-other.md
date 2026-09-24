# TODO — two chains closing one set fence can wait on each other

**Status**: open, production reachability undetermined. Found 2026-09-24 by the debugger pass that verified
the #380 fix; that fix is correct for the reported chain and does not cover this.

## The fact

`ProviderOperationMutationAdmission.closeSet` (`src/store/provider-operation-journal.ts`) creates one fence
per set and admits every active mutation whose `setKey` is `null` or that set. Each call excludes only **its
own** admission chain from the pending report and from `#drainSet`'s wait. So when two admitted mutations in
different chains both close the same set and each awaits its `retryAfter`, each waits on the other's still
active token, and neither settles. A fence created in one chain and awaited from an already admitted token in
another context produces the same wait. The debugger reproduced both with a two-closer case outside the
repository.

A second, pre-existing shape: the whole-admission `close()` collects every active token and `#drain()` waits
on all of them, so a mutation that awaits `close().retryAfter` from inside its own admission waits on itself.
Shutdown calls `close()` (`src/coordinator/lifecycle.ts`), but no shutdown caller was found that awaits it
from within an admission, and the shutdown sequence has a settlement budget.

## Why it is not simply "exclude the other closer too"

The fence exists so containment proof runs only after mutations that can still change the set have finished.
Dropping an unrelated active mutator from the wait merely to break the cycle could let a proof run while that
mutator is still writing. The two closers need a protocol — one waits and the other receives a defined retry
outcome — not a wider exclusion.

## Start condition

Establish whether any production route starts two closers of the same set concurrently: the four `closeSet`
sites are the recovery dispatcher's containment proof, the operator disposition proof, the operator exit
fence (`src/coordinator/composition/execution-services.ts`), and set inheritance's fenced containment proof
(`src/coordinator/services/provider-proxy-set/inheritance.ts`). If none can, record the constraint as an
invariant instead; if one can, it is the shape of #380 again and belongs next to
[`provider-operation-startup-reconciliation-unbounded.md`](./provider-operation-startup-reconciliation-unbounded.md),
whose bound would at least turn it into an incident rather than a hang.
