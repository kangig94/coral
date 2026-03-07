# Backend Request Cwd Must Propagate Beyond SessionManager Selection
## Rule
When introducing a shared backend that serves requests from multiple workspaces, request `cwd` must flow into both session-registry selection and the actual CLI execution defaults. Selecting `SessionManager` by `cwd` is not enough if provider handlers or workflow recursion still fall back to daemon-level `process.cwd()` when `work_dir` is omitted.
## Why
Without full propagation, a backend started from one workspace silently executes later requests from another workspace in the wrong directory. The bug is easy to miss because session lookup can appear correct while new `exec` and `coral:*` launches still inherit the daemon’s startup directory.
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
// workflow nested dispatch must preserve the same work_dir on launch/resume
```
