# Backend Daemon: Keep Wait Local When Progress Is Already File-Backed
## Rule
If `wait` already resolves session IDs to shared on-disk state and tails progress files locally, do not add a second streaming transport just to preserve progress notifications across a daemon split. Keep `wait` in the proxy until there is a proven requirement that the proxy cannot read the same session files.
## Why
A daemon migration often tempts designs into "everything must proxy" purity, but coral's `wait` path is already transport-agnostic: it polls `status.json` and `progress.jsonl` under the shared session directory. Introducing SSE for proxy-to-backend wait traffic adds a second protocol, parser, and lifecycle surface without adding capability on a single machine. It also obscures the simpler truth that only job ownership must move to the daemon; read-only progress observation may not need to.
## Pattern
```text
WRONG
proxy wait -> backend SSE -> proxy parses stream -> MCP notifications/progress

RIGHT
proxy exec/fork/list/abort -> backend
proxy wait -> read shared session files locally -> MCP notifications/progress
```
