# TODO — Coral-owned paths under a root every user on the host can write

**Status**: open, unfixed, and found by sweeping for the class the socket-identity work belongs to rather
than by a failure. That work fixed one such path. These are the rest, and one of them holds more than a
socket does.

The shared question is the same at every site: on Linux with no `TMPDIR`, `os.tmpdir()` is `/tmp` —
world-writable and world-listable, and conventionally but not necessarily carrying the restricted-deletion
bit that stops one user removing another's entry. On macOS the `os.tmpdir()`-derived sites instead use the
per-user `/var/folders/…` at mode `0700`, so this class does not show up at sites 1–3 there. Site 4 does not
use `os.tmpdir()`: without an override it still derives the literal `/tmp/claude-<uid>`, where a foreign
pre-created entry remains reachable. A path Coral puts under a shared root needs a name another user cannot
usefully pre-empt, a mode, a check of that parent property rather than a reliance on it, and a decision about
what happens when the entry is already someone else's. Only the socket path does any of this;
`ensurePrivateSocketDir` (`src/infra/private-socket-directory.ts`) is what the others would reuse.

`socket-address-ownership.md` holds this question for the socket itself and has not answered it. The
per-user naming below inherits that answer; the modes do not, and are worth doing alone. What that entry's
part 3 records applies here too: the assertion these sites would reuse proves owner and mode, and on macOS
that is not effective access.

## 1. `/tmp/coral-jobs` — the job scratch root

`jobsDir` (`src/jobs/paths.ts`) is `join(env.tmpdir(), 'coral-jobs')`. Three things live in
`/tmp/coral-jobs/<jobId>/`, written by the durable-CLI wrapper in `src/runtime/real.ts`:

- `env.json` — the composed child environment. `composeChildEnv` (`src/infra/env-sanitize.ts`) removes
  internal Coral keys and sheds by budget; it does not filter secrets, so whatever the parent shell held
  is in the file. On a developer machine that is routinely a provider API key.
- `stdout` and `stderr` — the provider's raw transcript.

None of the three is written with a mode. `writeAtomicJson` calls `writeAtomicSync` with no `mode`, and the
wrapper opens the two streams with a bare `openSync(path, 'w')`, so all three land at `0666 & ~umask` —
`0644` under the common default. The directories are the same: `initJob` and `appendLaunchRequested`
(`src/jobs/store.ts`) both call `mkdirSync(dir, { recursive: true })` with no mode.

A `jobId` is a UUID, so the leaf cannot be guessed. The parent can: `/tmp/coral-jobs` is a literal. If another
user creates it first with an ordinary mode that excludes Coral, the nested `mkdirSync` fails with `EACCES`:
the result is denial of service, not a directory full of disclosed ids. If the attacker instead permits Coral
to create beneath the foreign-owned parent, they can list each UUID leaf Coral creates. The parent owner can
also rename or unlink Coral's entries, and a recursive `rmSync` of a job directory (`src/jobs/store.ts`,
`src/coordinator/services/recovery/actions.ts`) then deletes through a path whose resolution someone else
controls.

Smallest fix: `0600` on the `env.json` write and a mode argument on the wrapper's two `openSync` calls.
`0700` on the two `mkdirSync` calls. The per-user rename waits on `socket-address-ownership.md`.

## 2. `/tmp/coral-input-<hash>.txt` — the Bash rewrite hook's inline-text spill

`writeInlineTextFile` (`clients/hooks/bash-rewrite.mjs`) turns an inline `-i "…"` argument into a file so
the command stays inside argv limits. It names that file `sha256(content)[0:12]`, in `tmpdir()` directly.
The mode is `0600`, which is the one site here that sets one — and it is the site where the mode is not
enough, because a **content-addressed name in a shared namespace is not the writer's to claim**:

- `writeFileSync(path, value, { mode })` opens `O_CREAT|O_TRUNC` and follows symlinks, and `mode` applies
  only when the file is created. Another user who can predict the content — a skill-generated invocation is
  byte-identical across machines — pre-creates that name as a symlink to something the victim can write, and
  the hook truncates it and writes the prompt text there instead.
- Two users on one host who pass the same text collide on one filename. The first owns it at `0600`; the
  second's write fails `EACCES`. The hook's top-level `catch { process.exit(0) }` means that failure is
  silent and the command simply runs unrewritten.
- The name is also an oracle: `/tmp` is world-listable, so the presence of a given hash confirms that
  someone on the host ran that exact prompt, even though the content stays unreadable.

Smallest fix: a random name rather than a content hash, and `flag: 'wx'` so an existing entry is an error
rather than a target. Nothing here needs the namespace decision.

## 3. `/tmp/coral-discovery-<uuid>.md` — the KB curate corpus

`buildDiscoveryPrompt` (`src/kb/curate/discovery.ts`) writes the note corpus it hands a provider through
`writeFileAtomic`, which passes no mode. The name is a UUID, but it sits directly in a world-listable `/tmp`
rather than under a Coral-owned parent, so the name is read rather than guessed. The content is the user's
own KB note bodies. One `mode` argument closes it. Whether the file is ever unlinked is not established
here.

## 4. `/tmp/claude-<uid>` — the hooks' state root

`sandboxTmpDir` (`clients/hooks/lib/plugin-paths.mjs`) is `/tmp/claude-<uid>` unless
`CORAL_WORK_ROOT_OVERRIDE` names something else, already per-user by default, and the
live-work registry and compaction snapshots live beneath it. It is the harness's own sandbox scratch
convention rather than Coral's namespace, and Coral's `mkdirSync(dir, { recursive: true })` calls create
every missing component of it with no mode when the harness has not already.

This is the weakest of the four and may not be Coral's to fix: what the harness does with that directory,
and when, was not established here. What is Coral's is that its own `mkdirSync` calls pass no mode and its
hooks never check whose directory they landed in. A hook may not refuse — fail-open is the contract — so the
disposition here is to skip recording, not to stop the command.

## Not verified here

Whether anything outside `src/` — a skill, an operator runbook, a user's own tooling — depends on the
literal `/tmp/coral-jobs` path. A rename has to answer that first. Also unverified: what an older build does
when it meets a `0700` directory a newer build tightened, which is the
`.claude/rules/design-philosophy.md` principle 10 question for whichever shape this takes.

## Start condition

Sites 1 (modes), 2, and 3 have none. The per-user naming for site 1 wants `socket-address-ownership.md`
half 2 decided first, for the same reason that entry gives: the two options put the per-user boundary in
different places.
