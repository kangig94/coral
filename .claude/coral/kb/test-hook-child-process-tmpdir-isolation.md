# Child-process hook tests should isolate `tmpdir()` via `TMPDIR`
## Rule
When testing hook scripts by spawning `node hook.mjs`, isolate any `os.tmpdir()`-derived paths by setting `TMPDIR` in the child process environment instead of writing fixtures into the shared real `/tmp` tree. This keeps the hook behavior real while giving each test its own `coral-jobs` root.
## Why
Spawned hook tests do not share the parent test process's module mocks, so import-time or runtime `tmpdir()` usage inside the hook will still resolve against the child environment. If tests write into the real `/tmp/coral-jobs`, they can collide with developer state, parallel workers, or unrelated suites and produce non-deterministic recovery results.
## Pattern
Right:
```ts
const fixtureRoot = mkdtempSync(join(tmpdir(), 'coral-hooks-'));
const childTmpRoot = join(fixtureRoot, 'tmp-root');
mkdirSync(childTmpRoot, { recursive: true });

spawnSync('node', [hookPath], {
  input: JSON.stringify(stdin),
  env: {
    ...process.env,
    TMPDIR: childTmpRoot,
  },
});

const jobsDir = join(childTmpRoot, 'coral-jobs');
```

Wrong:
```ts
const jobsDir = '/tmp/coral-jobs';
writeFixtureJobsInto(jobsDir);
spawnSync('node', [hookPath], { input: JSON.stringify(stdin) });
```
