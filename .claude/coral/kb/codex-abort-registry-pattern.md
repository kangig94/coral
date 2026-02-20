# Execution Registry: Identity-Safe Unregister and Abort-by-Name

## Rule
The active execution registry (`Map<string, AbortController>`) must use identity-safe unregistration: `unregisterExecution(name, controller)` only deletes the entry when the stored controller reference matches the passed reference. This prevents a stale `finally` block from deleting a newer execution's controller when the same session is re-used.

Thread-ID abort resolution has an inherent gap: aborting an in-flight `codex_session_create` by thread ID fails because the session entry doesn't exist in `SessionManager` until `executeOneShot` completes. The registry is always keyed by session name, not thread ID. Users must abort in-flight creates by session name.

## Why
Without identity-safe unregistration: Execution A starts, B replaces A (aborting it), then A's `finally` calls `unregisterExecution(name)` unconditionally — this deletes B's active controller, making B unabortable and creating a silent race. The bug is hard to reproduce because the window between B's register and A's finally is narrow.

Thread-ID abort without a registered session returns false from `abortExecution(sessionName)` with a clear error message mentioning "still be initializing."

## Pattern

```typescript
// Correct: identity-safe (controller reference comparison)
export function unregisterExecution(name: string, controller: AbortController): void {
  if (activeExecutions.get(name) === controller) {
    activeExecutions.delete(name);
  }
}

// Usage in handlers: always pass the same controller reference
const controller = registerExecution(sessionName);
try {
  await executeOneShot(..., controller.signal);
} finally {
  unregisterExecution(sessionName, controller); // safe: only deletes if this run's controller
}

// WRONG: unconditional delete
export function unregisterExecution(name: string): void {
  activeExecutions.delete(name); // deletes even if a newer run registered after us
}
```
