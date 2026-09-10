# Launch-slot release identity — resolved

Field observations on 2026-08-23 and 2026-08-24 found more active launch reservations than live jobs. A
third report on 2026-09-09 followed a provider usage-limit stop. Those measurements established lost
capacity, but did not distinguish a wrong-pool release from an internal `spawndurable-*` holder or a carrier
that never returned.

The release defect is now closed. Admission issues an opaque, generation-bound `LaunchPermit`, and the only
release operation accepts that exact permit. It reports whether the reservation was released, had already
been released, or had transferred to another holder. There is no default pool and a copied permit from an
older reservation cannot release a newer reservation that reused the job ID. Health diagnostics name aged
or uncarried permits by reservation, job, pool, holder, and execution owner, and the reported holder can be
aborted through its lifecycle authority.

This does not establish that a wrong-pool call caused any of the field incidents. The most likely explanation
for the usage-limit incident is the separately tracked local app-server stream inactivity defect, which this
change deliberately does not close.

## Start condition

Closed by the exact-permit admission migration. Reopen only if an exact permit release fails to return
capacity after its holder has settled, or if diagnostics show a reservation whose recorded lifecycle exit
completed without releasing that same generation.
