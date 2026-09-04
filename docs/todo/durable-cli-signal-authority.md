# TODO — finish durable-CLI signal authority and refusal status

**Status**: identity-safe containment, durable hold status, retry, and operator abandonment are implemented.

Starvation does not kill the coordinator. A crash can therefore lose the current refusal's visibility or
strand artifacts, but it must not lose authority over live work. Recovery remains unable to act without its
own observation, while the recorded process containment remains evidence rather than signal authority by
itself.

## Subject after durable CLI v2

The durable subject is no longer the wrapper pid alone. It contains:

- the detached wrapper leader's {pid, incarnation};
- the process-group id established by that leader;
- the provider command's root {pid, incarnation}.

Absence requires the process group and the recorded child root to be absent. A wrapper death alone decides
nothing about the provider command. The version-addressed durable_cli_process.v2 key makes this payload
invisible to an older v1 selector. Current readers classify missing, corrupt, identity-mismatched, and
predecessor evidence separately; none of those classifications proves absence.

A durable_cli_process.v1 row still identifies the wrapper pid and its recorded incarnation. It is useful for
displaying which legacy process representation is held and for selecting that job for operator abandonment.
It does not name the process group or the provider child root, so it cannot authorize TERM, KILL, or process
absence. Repair must reconstruct and publish the complete v2 subject from independent evidence; copying the
v1 pid into the missing fields would manufacture authority.

## Decided status design

The durable row for a refused signal is job-scoped and belongs on the jobs domain's existing stream. It is not
a provider-proxy record and not an entry in a cross-domain hold store.

The version-addressed durable_cli_containment_status.v1 row is keyed by job and carries the evidence
classification plus either `held` or `operator-abandoned`. For a v2 launch, the exact subject is embedded in
the evidence. For a recovered v1 launch, the legacy pid and incarnation remain visible without being promoted
to signal authority. The row is evidence, never authority; the current coordinator re-observes a complete v2
subject before signalling.

Cleanup publishes `held` before an asynchronous signal attempt begins and retries on a fixed schedule that is
independent of provider output and provider exit. Confirmed absence clears the hold. Operator abandonment is
retained through terminalization with `processAbsenceProven: false`, then terminal cleanup removes the current
status together with the v2 identity.

The first `coral-cli abort <job-id>` requests cleanup. If absence is not already proven, the abort result is a
hold rather than an aborted result. Running the same command again against the published hold explicitly
abandons Coral's job representation without sending another signal or claiming that the process ended. This
is the same abandonment operation for live cleanup holds and recovery holds.

Startup recovery writes an ordinary job progress event for job-detail visibility and an active
`coordinator-job-recovery` quarantine for backend status and repair retries. It does not report the job as
adopted while containment is unobservable. Repairing or reconstructing complete v2 evidence and retrying that
quarantine re-runs observation; operator abandonment removes the quarantine under the same coordinator
ownership before terminalizing the job as aborted.

Do not solve this with a unified jobs-and-proxy hold store. It would erase owner vocabulary, violate the
store/proxy layering boundary, and invite unrelated obligations into one content-blank abstraction.
