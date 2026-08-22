# TODO — Coral-owned paths under a root every user on the host can write

**Status**: partly closed. Found by sweeping for the class the socket-identity work belongs to rather than
by a failure; that work fixed one such path, and these were the rest. Sites 2 and 3 are struck, and so are
site 1's three file modes. What is left is site 1's directory mode — which cannot be set before the naming
question below is answered — and site 4.

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
per-user naming below inherits that answer, and so does site 1's directory mode — that site says why the
two cannot be separated. The file modes and site 2's naming do not, and are worth doing alone. What that
entry's part 3 records applies here too: the assertion these sites would reuse proves owner and mode, and
on macOS that is not effective access.

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

Struck, for the three files: `env.json` is written `{ mode: 0o600 }` through `writeAtomicSync`, and the
wrapper opens `stdout` and `stderr` with an explicit `0o600`. A real-runtime test asserts all three modes.

The **directory** mode was not part of that and does not belong beside them. Node applies a recursive `mkdirSync`'s `mode` to every
component it creates, not only the leaf — measured on Node 26.3.1, where `mkdirSync(root + '/leaf', {
recursive: true, mode: 0o700 })` reports `700` on `root` as well — and both call sites pass
`<tmpdir>/coral-jobs/<jobId>` with `recursive: true`. `0700` would therefore land on the literal
`/tmp/coral-jobs` whenever Coral is the process that creates it, and lock every other uid on the host out
of Coral with the same `EACCES` this site describes as the attack. The directory mode is part of the
per-user rename and waits with it on `socket-address-ownership.md`; only the three file modes are
separable.

## 2. `/tmp/coral-input-<name>.txt` — the Bash rewrite hook's inline-text spill

Struck: fixed. The name was `sha256(content)[0:12]`, and a content-addressed name in a shared namespace is
not the writer's to claim — `writeFileSync` opens `O_CREAT|O_TRUNC` and follows symlinks, so anyone who
could predict the content could pre-create that name as a link and receive the prompt text at its target.
The name now comes from `randomBytes`, and the write carries `flag: 'wx'`, which is the half that actually
refuses: `O_CREAT|O_EXCL` fails `EEXIST` on an existing path including a symlink, dangling or not. `wx` also
makes the pre-existing `mode: 0o600` unconditional, since the file is now always the one being created.
Both halves are asserted — one test runs the hook under a zero umask and reads the spill's mode, another
pre-creates the spill path as a symlink and proves the target is untouched and the hook still fails open.

Two things the fix does not do, and neither is a defect: identical prompts no longer collapse onto one
file, and nothing in production unlinks these files — that was true before and is unchanged.

## 3. `/tmp/coral-discovery-<uuid>.md` — the KB curate corpus

Struck: fixed. `buildDiscoveryPrompt` (`src/kb/curate/discovery.ts`) now asks `writeFileAtomic` for mode
`0600`, which it applies to the temporary file so the rename carries it — a `chmod` after the rename would
leave a window at `0644`, which is the thing being fixed. No other caller of `writeFileAtomic` changed.

The sweep recorded that whether the file is ever unlinked was not established. It is now: `runPrincipleDiscovery`
(`src/kb/curate/principles.ts`) calls `unlinkIfExists(corpusPath)` in a `finally`.

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

What remains is site 1's directory mode, its per-user rename, and site 4. The first two want
`socket-address-ownership.md` part 2 decided first, for the same reason that entry gives: the two options
put the per-user boundary in different places. Site 4 wants an answer about whose directory it is before
anything is done to it.
