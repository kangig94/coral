# Hook unit tests spawn backends against the developer's real `~/.coral`

**Status**: open. Observed 2026-09-18 while diagnosing a coordinator death.

## What was seen

The live coordinator's log at `~/.coral/gen2/run/coordinator.log` contained 108 copies of

```
Error: Cannot find module '/dev/shm/coral-1000/coral-hooks-DkRKcG/plugin-root/bridge/coral-backend.cjs'
  code: 'MODULE_NOT_FOUND'
```

with a different random suffix each time. `coral-hooks-<random>` is created by `createFixture` in
`tests/unit/hooks/_helpers.ts` (`mkdtempSync(join(tmpdir(), 'coral-hooks-'))`), which also declares a
`plugin-root` inside it. So these are **unit-test fixtures**, and the backend spawns they produced wrote
their crash output into the developer's real run directory.

## Why they reach the real home

`runHook` in the same file builds the child environment from `{ ...process.env }` and then deletes
`CORAL_CHILD`, `CORAL_KB_PATH`, `CLAUDE_CONFIG_DIR`, `CORAL_WORK_ROOT_OVERRIDE`, `COPILOT_PLUGIN_ROOT`
and `AI_AGENT`. It does not delete or override `HOME`. A hook that resolves `~/.coral` therefore resolves
the developer's own, unless the individual test passes `HOME` in `envOverrides`.

The e2e lifecycle suites do this correctly — `temporary-home-lifecycle.ts` gives each fixture its own
`HOME` and the starvation test reads the pid it kills from *that* fixture's discovery record — so the
gap is specific to the hook unit fixture.

## Why it matters beyond the noise

The crashes themselves are harmless: the fixture directory is gone by the time the spawn runs, so the
child dies at module load having done nothing. The hazard is the case that does not crash. A hook spawn
that resolves a valid plugin root while pointed at the real `HOME` becomes a genuine contender for the
live coordinator's socket and discovery record, and the contention is invisible because it looks like
ordinary lifecycle traffic. It also means `npm test` is not side-effect-free on a machine that is using
Coral, which is every developer machine here.

## What a fix has to decide

Whether `runHook` should force an isolated `HOME` for every hook test (and what the few tests that
deliberately exercise real-home resolution do instead), or whether the hook entry points should refuse to
spawn a backend when the plugin root is under a temp directory. The first is smaller; the second closes
the class for any future caller.
