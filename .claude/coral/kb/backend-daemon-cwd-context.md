# Backend Daemon: Replace `process.cwd()` with Explicit Caller Context
## Rule
When migrating a per-session stdio server into a detached backend daemon, treat every `process.cwd()` default as suspect. A long-lived daemon's current working directory is the daemon launch directory, not the caller workspace. Execution cwd, session namespace, and workflow registration must be carried explicitly through the request contract or normalized before calling existing handlers.
## Why
Code that is correct in a short-lived MCP stdio process can become silently wrong in a persistent daemon. Coral currently uses `process.cwd()` for `SessionManager` construction, workflow launch metadata, and provider defaults when `work_dir` is omitted. After daemonization, those same fallbacks can redirect launches to the wrong project and shard session lookup under the wrong namespace.
## Pattern
```typescript
// WRONG: detached backend reuses handler defaults that assume process-local cwd == caller cwd
const mgr = new SessionManager(process.cwd());
const workingDirectory = input.work_dir ?? process.cwd();

// RIGHT: request carries caller context and handlers use that explicit value
type CallerContext = { projectRoot: string };

const mgr = new SessionManager(context.projectRoot);
const workingDirectory = input.work_dir ?? context.projectRoot;
```
