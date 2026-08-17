export const SIGTERM_GRACE_MS = 5_000;
export const SIGKILL_GRACE_MS = 5_000;
export const CONTAINMENT_DISAPPEARANCE_CONFIRM_MS = 1_000;
export const CONTAINMENT_PROCESS_CONTROL_CALL_MAX_MS = 500;
export const MAX_BUFFER = 10 * 1024 * 1024;
/**
 * The bound `ProcessPort.execSync` applies when a caller names none. Not a schedule any particular command
 * needs — a command with a real schedule passes its own — but a floor, because omitting it on a *synchronous*
 * subprocess means blocking the event loop for as long as the child likes, which nothing in this process can
 * interrupt. The asynchronous `exec` needs no equivalent: its caller can abandon the promise.
 */
export const DEFAULT_SYNC_EXEC_TIMEOUT_MS = 30_000;
