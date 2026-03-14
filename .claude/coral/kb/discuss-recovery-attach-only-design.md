# Discuss Recovery Must Be Attach-Only — No Auto-Resume
Promoted: 2026-03-14 | Updated: 2026-03-14
## Rule
`recoverPersistedSessions()` must only call `attachSession()` for each candidate — never `continueLoop()`. Sessions resume execution only when the user explicitly re-engages via `discuss_participate`, which calls `resumeLoop()` through `submitManualBid` / `submitManualSpeech`. Auto-resuming all sessions at startup violates the user-interaction contract and blocks backend readiness.
## Why
`continueLoop` awaits long-running async operations (synthesis agent turn, speech collection, bid rounds). Calling it during `start()` — before `listen()` and `writeBackendInfo()` complete — means a single stalled session prevents the backend from accepting any connections. If providers aren't registered yet when `controlPhase === 'synthesize'`, the loop hits `rejectLaunch → catch { return } → continue` as a tight infinite loop at 100% CPU. Additionally, mass-resuming all sessions across all project roots simultaneously at startup is undesirable UX.
## Pattern
Right — `recoverPersistedSessions` is attach-only:
```ts
async recoverPersistedSessions(ctx: CallerContext): Promise<void> {
  for (const candidate of this.store.listRecoveryCandidates()) {
    const snapshot = this.store.load(candidate.sessionId);
    if (!snapshot) continue;
    const events = this.readSessionEvents(candidate.sessionId);
    const abortEnded = this.isAbortEnded(events);
    if (abortEnded) continue;
    // Attach only — continueLoop fires when the user re-engages via discuss_participate
    this.attachSession(snapshot, buildWatchEvents(events), abortEnded);
  }
}
```

Wrong — auto-resuming inside recovery:
```ts
for (const sessionId of resumableSessionIds) {
  await this.continueLoop(sessionId, ctx);  // blocks startup, mass-resumes all sessions
}
```
