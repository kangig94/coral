export const SIGTERM_GRACE_MS = 5_000;
export const SIGKILL_GRACE_MS = 5_000;
export const CONTAINMENT_DISAPPEARANCE_CONFIRM_MS = 1_000;
export const CONTAINMENT_PROCESS_CONTROL_CALL_MAX_MS = 500;
export const MAX_BUFFER = 10 * 1024 * 1024;
/**
 * The bound `ProcessPort.execSync` applies when a caller names none. Not a schedule any particular command
 * needs — a command with a real schedule passes its own — but a floor, because omitting it on a *synchronous*
 * subprocess means blocking the event loop for as long as the child likes, which nothing in this process can
 * interrupt. The asynchronous `exec` needs no equivalent — not because abandoning its promise stops anything
 * (it does not; the child runs on), but because the event loop stays free while it does, so the caller keeps
 * the ability to time out, abort, or shut down. That ability is the whole difference.
 *
 * 30s is chosen to be uninteresting rather than correct. Every command with a real schedule passes its own —
 * 2s for the incarnation probes and for `git remote get-url`, 5s to 30s across git-sync, where a synchronous
 * `git reset --hard` and `rebase --continue` already name 30s themselves. So this is not a ceiling above all
 * of them; it is the value a caller that named nothing lands on, and it sits at the top of the range the
 * deliberate callers chose rather than below it. What it bounds is the difference between a wedged child and
 * a permanently wedged process, and for that a loose bound and a tight one are the same fix.
 */
export const DEFAULT_SYNC_EXEC_TIMEOUT_MS = 30_000;

/**
 * The `code` the runtime's exec ports stamp on the failures they synthesize themselves.
 *
 * These restore something rather than adding it. `spawnSync` does report a timeout with `code: 'ETIMEDOUT'`
 * (alongside `signal: 'SIGTERM'`) — the port then replaced that error with a bare `new Error('timeout: git')`
 * to carry a friendlier message, and the code went with it. A caught error with no `code` is
 * indistinguishable from a child that ran and exited non-zero, so every caller sorting "the command answered"
 * from "the command could not be run" put the timeout on the wrong side — including `isGitRepo`, which cached
 * it and disabled KB git sync until the daemon restarted.
 *
 * So the value is `spawnSync`'s own, deliberately: one condition should not acquire a second name on its way
 * through a port. The asynchronous path kills on its own timer and never sees `spawnSync`, and uses the same
 * code for the same reason. Both are absent from `STANDING_PROBE_ERRNOS` below — neither says anything about
 * the next attempt.
 */
export const EXEC_TIMEOUT_CODE = 'ETIMEDOUT';
export const EXEC_MAXBUFFER_CODE = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';

/**
 * Errnos from a failed subprocess *launch* that are a standing fact about this environment rather than about
 * this moment: git is not installed, or this process may not execute it, or the working directory is not one.
 * None of them changes under a running daemon, so a repeat launch of the same command fails the same way again
 * — that is the one thing membership in this set says on its own.
 *
 * It does not say the probe's *question* was answered. Standing describes the launch failure itself, not what
 * the caller asked with it: a probe launched to learn whether a directory is a git repository, or a project has
 * a remote, asks a domain question that `ENOENT` on `git` never touches — the binary being absent says nothing
 * about the repository. A `launch-refused` outcome (`ExecOutcome`, `infra/port-types.ts`) is therefore not
 * `answered` for a caller asking a domain question, and must be treated exactly like `no-answer`: indecisive,
 * remembered only for `INDECISIVE_PROBE_REPROBE_INTERVAL_MS`. Conflating the two is how a missing `git` binary
 * became a cached, durably wrong "not a repository" — the caller's whole domain question, decided by evidence
 * that never addressed it.
 *
 * Because the failure is standing rather than transient, that reprobe never resolves on a permanently broken
 * host — but it stays a flat, cheap cost (one probe per interval, forever) rather than a wrong answer cached
 * for the daemon's life, which is the trade this set exists to make affordable.
 *
 * A caller whose own question IS "can this binary be launched at all" is different, and reads this set
 * directly rather than going through `ExecOutcome`: `live-work-registry.mjs`'s flock probe asks exactly that —
 * not anything about the lock it would take — so for it a launch failure in this set is itself the decisive
 * answer, routed to its own designed fallback (an mtime window) rather than a re-probe.
 *
 * The enumeration is on this side deliberately, and the reason is which mistake it makes cheap. Listing the
 * *transient* errnos instead puts the dangerous outcome on the default: every errno nobody thought of becomes
 * a wrong answer cached for the process's lifetime. Listing the standing failures makes a missed entry cost a
 * wasted fork instead, so this list may be incomplete without being unsafe.
 *
 * This says nothing about a launch that *succeeded* and exited non-zero. That is an answer whatever the code,
 * and each caller reads it from its own result rather than from here.
 */
export const STANDING_PROBE_ERRNOS: ReadonlySet<string> = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR']);

/**
 * How long a probe that could not be answered is left alone before being tried again.
 *
 * Refusing to cache an indecisive outcome is what stops a transient failure becoming permanent, but "probe
 * again next time" is not free when the caller sits in a loop: an unbounded retry turns one stalled mount into
 * one synchronous, uninterruptible block per iteration, which is worse than the wrong answer it replaced.
 * Remembering the non-answer *with an expiry* is neither — a recovered environment still self-heals, and a
 * wedged one costs one probe per interval rather than one per call.
 */
export const INDECISIVE_PROBE_REPROBE_INTERVAL_MS = 60_000;
