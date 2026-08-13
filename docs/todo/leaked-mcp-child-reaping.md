# TODO — remaining MCP child-reaping gaps

## What remains

### Upstream Codex thread lifecycle

The upstream defect remains open: a codex app-server can spawn MCP servers per thread without tracking or
reaping them when those threads end. See
[openai/codex#30408](https://github.com/openai/codex/issues/30408). Coral's host-level containment and idle
retirement do not repair lifecycle ownership inside codex itself; the leak can recur while a host remains
alive.

### Coral proxy-host scope limit

When a live proxy set exists for a job's executable identity, Coral routes its app-server operation through
that set. Closing a proxy-owned host—including idle retirement or exact eviction—calls the app-server
handle's child-only close; it does not group-reap that host's MCP descendants. Those descendants can remain
in the guardian-established set until the entire proxy set is torn down. The shipped work therefore does not
provide per-host descendant reclamation on this production-preferred path; it moves the accumulation bound
from coordinator lifetime to proxy-set lifetime.

Adding a per-host containment group inside a live proxy set would nest a containment boundary inside the
guardian's recorded group, which the current containment contract forbids. This requires a follow-up design.

### Coral coordinator-crash recovery

If the coordinator is killed before it can reap a coordinator-local provider host's recorded group, the
app-server and its MCP children can survive without a live owner. Durable recovery for that case is not
shipped; its authority and pre-store-routing order remain tracked in
[`store-format-routing.md`](store-format-routing.md).

## Operator remedy

For an affected host still owned by a live Coral process, inspect and evict that exact host:

```text
coral-cli backend provider-host list
coral-cli backend provider-host inspect <ph1.…>
coral-cli backend provider-host evict <ph1.…>
```

For a coordinator-local host, eviction reaps its recorded process group, including MCP descendants in that
group. Exact eviction of a proxy-owned host closes only that app-server; its leaked descendants can remain
until proxy-set teardown reaps the guardian-established group. A coordinator-local group already orphaned by
a coordinator crash still requires operator-directed OS process cleanup.
