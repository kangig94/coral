# Cross-Process Mutex via mkdir for Multi-Agent State

## Rule
When multiple Claude agent processes share mutable state via a filesystem file, use a cross-process POSIX-atomic lock: `fs.mkdirSync(lockDir)` fails with `EEXIST` if held (guaranteed atomic by POSIX). This gives a test-and-set primitive with no external dependencies. In-process Promise chains only serialize within a single process and are invisible to other processes.

## Why
In Claude Code Agent Teams, each teammate runs as a separate MCP server process. Multiple processes doing read-modify-write on the same state file causes lost updates even with atomic rename (rename prevents partial writes, not concurrent read-modify-write races). Additionally, Promise-chain mutexes can suffer rejection poisoning if prior rejections aren't absorbed.

## Pattern
```typescript
class SessionLock {
  async acquire<T>(sessionDir: string, fn: () => Promise<T>): Promise<T> {
    const lockDir = path.join(sessionDir, 'state.lock');
    const pidFile = path.join(lockDir, 'pid');
    for (let i = 0; i < 10; i++) {
      try {
        fs.mkdirSync(lockDir);  // POSIX atomic test-and-set: throws EEXIST if held
        fs.writeFileSync(pidFile, `${process.pid}-${Date.now()}`);
        try {
          return await fn();
        } finally {
          try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
          try { fs.rmdirSync(lockDir); } catch { /* ignore */ }
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        // Stale lock detection: check PID liveness + 30s age threshold
        // 30s = 150x the max lock hold budget (~200ms), allows crash recovery
        const content = fs.readFileSync(pidFile, 'utf8');
        const [pid, time] = content.split('-').map(Number);
        const isAlive = (() => { try { process.kill(pid, 0); return true; } catch { return false; } })();
        if (!isAlive || Date.now() - time > 30_000) {
          fs.unlinkSync(pidFile); fs.rmdirSync(lockDir); continue;
        }
        await sleep(baseDelay * Math.pow(2, Math.min(i, 5)) + Math.random() * baseDelay);
      }
    }
    throw new Error('Lock timeout');
  }
}

// Wrong — in-process only, invisible to other processes
const prev = chains.get(id) ?? Promise.resolve();
prev.then(fn);
```
