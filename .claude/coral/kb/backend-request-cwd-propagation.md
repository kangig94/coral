# Backend Request Cwd Must Propagate Beyond SessionManager Selection
## Rule
When introducing a shared backend that serves requests from multiple workspaces, request `cwd` must flow into both session-registry selection and the actual CLI execution defaults. Selecting `SessionManager` by `cwd` is not enough if provider handlers or workflow recursion still fall back to daemon-level `process.cwd()` when `work_dir` is omitted. For workflows, keep the coordinator/session provenance keyed to `projectRoot` and thread `work_dir` separately for atom subprocess cwd; do not rewrite `CallerContext.projectRoot` to `work_dir`.
## Why
Without full propagation, a backend started from one workspace silently executes later requests from another workspace in the wrong directory. The bug is easy to miss because session lookup can appear correct while new `exec` and `coral:*` launches still inherit the daemon’s startup directory. In workflow mode there is an extra failure mode: mutating `projectRoot` to `work_dir` contaminates session/progress provenance, while forgetting to thread `work_dir` to stale resume makes recovered atoms jump back to the project root.
## Pattern
```typescript
// Wrong: only scope persistence
const mgr = managers.get(request.cwd) ?? new SessionManager(request.cwd);
return handleToolCall(name, args, mgr);
// provider handleOp(...) still uses input.work_dir ?? process.cwd()
```

```typescript
// Right: propagate request cwd as execution default too
const mgr = managers.get(request.cwd) ?? new SessionManager(request.cwd);
const executionArgs = args.work_dir ? args : { ...args, work_dir: request.cwd };
return handleToolCall(name, executionArgs, mgr);
// workflow coordinator identity stays on request.cwd/projectRoot
// workflow atoms use work_dir ?? projectRoot for launch and stale resume cwd
```
