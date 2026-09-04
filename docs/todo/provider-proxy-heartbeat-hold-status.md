# TODO — persist provider-proxy hold status across coordinator death

**Status**: deliberately deferred from the starvation-survival branch.

The in-memory projection has three set-scoped gaps after coordinator death:

- heartbeat evidence and its preservation disposition;
- operator dispositions retained only by the lifecycle;
- acquisition cleanup holds whose recovery capability has no durable successor.

Starvation does not kill the coordinator, so none weakens this branch's guarantee. A coordinator crash can
lose visibility and leave artifacts behind, but it must not lose live-work authority: a successor cannot act
from its predecessor's record, and a leaked set must retain the orphan deadline armed when it spawned.

## Decided design

### Owner

Persist a keyed record beside src/store/provider-operation-record.ts. The store boundary accepts only plain,
validated process and set identities. The coordinator writes through a port injected into the lifecycle so
the lifecycle imports no store module.

This is not a Journal stream. Provider-proxy is deliberately outside the Journal-stream domains, and the
provider-operation saga already uses a keyed store record for the same ownership boundary.

### Staleness

Every record carries the writer's process identity as {pid, incarnation}. Bound-socket authority already
serializes coordinators, so a writer other than the reader is a predecessor by definition; no lease or epoch
counter is needed.

The record is evidence, never authority. A successor re-observes the recorded subject and reaches its own
disposition:

- confirmed absence retires the record;
- a live target produces a new hold under the successor's writer identity;
- an unattributable group enters the existing quarantine and operator-abandonment path.

### Retention and readers

Retire a row on the successor's own absence confirmation, on operator abandonment, or on terminal job cleanup
for a job-scoped row. Existing backend status diagnostics and startup recovery enumeration read the records;
the persistence work adds a source to those products rather than creating another product.

### Conditions on this deferral

The deferral was re-checked against the live role and recovery paths. The objection that a coordinator crash
necessarily creates an obligation gap was refuted: unobservable work remains owned by a live role, granted
roles expose supported recovery and operator surfaces, and roles that were never granted continue probing
rather than parking for an operator that cannot discover or authenticate to them.

The deferral remains honest only while all of these stay checkable:

1. Self-terminates whenever termination is observable; otherwise the obligation is retained by a live role
   whose hold is grant-readable and whose exits are named. For a granted role, a parked hold is reachable
   through the direct capsule-credentialed holder-status and abandon paths, a successor coordinator's
   `contain`, and absence delivery to the parked role.
2. Shutdown never reports confirmed past a live hold.
3. A crash can create a status gap, never an obligation gap.

### Rejected alternative

Do not create one unified hold store spanning jobs and provider-proxy sets. It would cross the enforced
layering boundary: provider-proxy may not import store, and jobs may not import proxy-domain brands. It would
also become a content-blank magnet for unrelated ownership vocabularies.

Use two instantiations of the same evidence-record pattern, each expressed in its owner's vocabulary.
