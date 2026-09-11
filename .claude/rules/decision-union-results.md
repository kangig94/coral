# Decision Union Results

Within `src/coordinator/`, `src/jobs/`, and `src/recovery/`, a call whose return type is a decision union may
not stand as a bare expression statement. Consume the decision, or prefix the call with `void` to mark an
intentional discard explicitly.

The scope is limited to ownership and recovery orchestration, where an unnoticed refusal can release or retain
the wrong obligation. Extending the rule elsewhere requires identifying the same decision-bearing contract.
