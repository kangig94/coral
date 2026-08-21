# TODO — the job scratch root is a fixed name under a root every user on the host can write

**Status**: open, unfixed, and found by sweeping for the class the socket-identity work belongs to rather
than by a failure. The socket fallback was one Coral-owned path under a shared root; this is the other one,
and it holds more.

`jobsDir` (`src/jobs/paths.ts`) is `join(env.tmpdir(), 'coral-jobs')`. On macOS `os.tmpdir()` is the
per-user `/var/folders/…` directory at mode `0700`, so this reads as private there. On Linux with no
`TMPDIR` it is `/tmp`, and the path is the fixed, guessable `/tmp/coral-jobs`.

Three things live in `/tmp/coral-jobs/<jobId>/`, all written by the durable-CLI wrapper in
`src/runtime/real.ts`:

- `env.json` — the composed child environment. `composeChildEnv` (`src/infra/env-sanitize.ts`) removes
  internal Coral keys and sheds by budget; it does not filter secrets, so whatever the parent shell held
  is in the file. On a developer machine that is routinely a provider API key.
- `stdout` and `stderr` — the provider's raw transcript.

None of the three is written with a mode. `writeAtomicJson` calls `writeAtomicSync` with no `mode`, and the
wrapper opens the two streams with a bare `openSync(path, 'w')`, so all three land at `0666 & ~umask` —
`0644` under the common default. The directories are the same: `initJob` and `appendLaunchRequested`
(`src/jobs/store.ts`) both call `mkdirSync(dir, { recursive: true })` with no mode.

## Why the unguessable job id does not carry it

A `jobId` is a UUID, so the leaf path cannot be guessed. The parent can: `/tmp/coral-jobs` is a literal.
Another user creates it first, owns it, and every id underneath becomes a directory listing. Owning the
parent also lets them rename or unlink Coral's entries, and a recursive `rmSync` of a job directory
(`src/jobs/store.ts`, `src/coordinator/services/recovery/actions.ts`) then deletes through a path whose
resolution someone else controls.

## What the socket work already built for this

`ensurePrivateSocketDir` (`src/infra/private-socket-directory.ts`) is the assertion this needs: create at
`0700`, decide ownership and type from a non-following `lstat`, tighten a loose mode that is already ours,
and refuse with `foreign`, `unusable`, or `unverified`. The namespace question is the same one
`socket-address-ownership.md` half 2 asks, and the two should be answered together rather than twice — a
per-uid `coral-jobs-<uid>` inherits that entry's undecided real-versus-effective question.

The file modes are separate and smaller: `env.json` wants `0600` at its write, and the wrapper's two
`openSync` calls want a mode argument. Those are worth doing even if the namespace decision waits, because
they are the difference between a world-readable credential file and one only its owner can read.

## The same class, one file smaller

`buildDiscoveryPrompt` (`src/kb/curate/discovery.ts`) writes the note corpus it hands a provider to
`join(env.tmpdir(), 'coral-discovery-<uuid>.md')` through `writeFileAtomic`, which passes no mode. The name
is a UUID, but it sits directly in a world-listable `/tmp` rather than under a Coral-owned parent, so the
name is read rather than guessed. The content is the user's own KB note bodies. One `mode` argument closes
it. Whether the file is ever unlinked is not established here.

## Not verified here

Whether anything outside `src/` — a hook, a skill, an operator runbook — depends on the literal
`/tmp/coral-jobs` path. A rename has to answer that first. Also unverified: what an older build does when
it meets a `0700` `coral-jobs` a newer build tightened, which is the
`.claude/rules/design-philosophy.md` principle 10 question for whichever shape this takes.

## Start condition

The mode fixes have none. The namespace change wants `socket-address-ownership.md` half 2 decided first,
for the same reason that entry gives: the two options put the per-user boundary in different places.
