# TODO — Coral-owned paths under a root every user on the host can write

**Status**: partly closed. Found by sweeping for the class the socket-identity work belongs to rather than
by a failure; that work fixed one such path, and sites 1–4 were the paths found in that sweep. Review later
found the community-summary agent's fixed `/tmp/coral-summary.txt` and the simulation backend's fixed
`/tmp/sim/project`. Sites 2 and 3 are struck, as are those two later paths and site 1's three file modes.
What is left is site 1's directory mode — which cannot be set before the naming question below is answered
— and site 4.

The shared question is the same at every site: on Linux with no `TMPDIR`, `os.tmpdir()` is `/tmp` —
world-writable and world-listable, and conventionally but not necessarily carrying the restricted-deletion
bit that stops one user removing another's entry. On macOS the `os.tmpdir()`-derived sites instead use the
per-user `/var/folders/…` at mode `0700`, so this class does not show up at sites 1–3 there. Site 4 does not
use `os.tmpdir()`: without an override it still derives the literal `/tmp/claude-<uid>`, where a foreign
pre-created entry remains reachable. A path Coral puts under a shared root needs a name another user cannot
usefully pre-empt, a mode, a check of that parent property rather than a reliance on it, and a decision about
what happens when the entry is already someone else's. Only the socket path does any of this;
`ensurePrivateSocketDir` (`src/infra/private-socket-directory.ts`) is what the others would reuse.

`socket-address-ownership.md` answered this question for the singleton socket with an installation-keyed
namespace plus a caller-ownership check. That does not silently choose the same identity for job scratch:
site 1 must first decide which installation fact its current environment-only path can carry. What that
entry's part 3 records applies here too: the assertion these sites would reuse proves owner and mode, and
on macOS that is not effective access.

## 1. `/tmp/coral-jobs` — the job scratch root

`jobsDir` (`src/jobs/paths.ts`) is `join(env.tmpdir(), 'coral-jobs')`. Three things live in
`/tmp/coral-jobs/<jobId>/`, written by the durable-CLI wrapper in `src/runtime/real.ts`:

- `env.json` — the composed child environment. `composeChildEnv` (`src/infra/env-sanitize.ts`) removes
  internal Coral keys and sheds by budget; it does not filter secrets, so whatever the parent shell held
  is in the file. On a developer machine that is routinely a provider API key.
- `stdout` and `stderr` — the provider's raw transcript.

None of the three was written with a mode. The durable launcher called `writeAtomicSync` with no `mode`, and
the wrapper opened the two streams with a bare `openSync(path, 'w')`, so all three landed at `0666 & ~umask` —
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

## Additional paths found during review

`src/kb/curate/community/summary-agent.ts` taught an agent to write user KB summary content through the
constant `/tmp/coral-summary.txt`, then passed that same path to `set-summary`. Each summary iteration now
runs `mktemp`, copies the path it prints, and uses that literal path both for the summary write and for the
same `--from <path>` command shape, without relying on shell state between commands.

`tools/simulation/core/backend.ts` used `/tmp/sim/project` as a real-filesystem project root. It now places
the default project root below the backend's existing `mkdtemp` root, so a foreign pre-created directory
in `/tmp` cannot lock every simulation run out.

## Simulation storage was part of the defect surface

The storage fake used to leave a mode-less file's mode absent and report `file.mode ?? 0o600` from stats.
That made every simulation-backed privacy assertion report `0600` regardless of production. Its parity
test pinned umask `077`, the one setting where Node's default `0666 & ~umask` also becomes `0600`.

The first repair applied create-with-umask semantics at every fake creation site. That repaired ordinary
file creation but regressed `tryExclusiveWriteSync`, whose real implementation chmods to `mode ?? 0600`,
and explicit-mode `writeAtomicDurableSync`, whose real implementation uses `fchmod` without applying the
umask. The fake now encodes those three creation policies separately, and the differential test covers both
`022` and `077` across ordinary, exclusive, atomic, and durable-atomic creation.

The fake still cannot represent a symlink. A green simulation therefore is not evidence that a write is
safe against the symlink/pre-emption threat model described by this entry; that evidence must come from a
real-filesystem test.

## Review boundary — file privacy policy has no decided owner

This review deliberately did not introduce a project-wide file or directory mode owner. Bare `0o600`
literals appear in roughly twenty places throughout `src/`, alongside `PRIVATE_FILE_MODE` in
`src/store/active-store-selection.ts`, `PRIVATE_CAPSULE_MODE` and `PRIVATE_DIRECTORY_MODE` in
`src/provider-proxy/bootstrap-capsule.ts`, `PRIVATE_HANDOFF_CAPSULE_MODE` in
`src/provider-proxy/handoff-capsule.ts`, and `REQUIRED_POSIX_MODE` in
`src/infra/private-socket-directory.ts`. `ensurePrivateSocketDir` is a directory-level primitive; there is
no file-level counterpart.

Two positions remain live:

- The bare literal is the established convention. Its evidence is that many file owners use `0o600`
  directly while the separately named constants express narrower owner-specific concepts. A generic
  shared constant could erase those distinctions without adding enforcement.
- The duplication is the defect. Its evidence is that the same privacy policy is independently spelled
  as literals and four constants, while no file-level primitive owns creation plus verification in the
  way `ensurePrivateSocketDir` does for directories.

This entry leaves that choice undecided.

The same review found that `createControlEndpoint` in
`src/provider-proxy/control-endpoint.ts` binds without the post-listen `chmodSync(0o600)` used by
`bindSocket` in `src/transport/ipc/server.ts`. That belongs to
[`socket-address-ownership.md`](./socket-address-ownership.md) part 1, not to this file-mode review, and was
not changed here.

## Not verified here

Whether anything outside `src/` — a skill, an operator runbook, a user's own tooling — depends on the
literal `/tmp/coral-jobs` path. A rename has to answer that first. Also unverified: what an older build does
when it meets a `0700` directory a newer build tightened, which is the
`.claude/rules/design-philosophy.md` principle 10 question for whichever shape this takes.

## Start condition

What remains is site 1's directory mode and rename, and site 4. The socket decision removes site 1's prior
blocker but does not decide whether job scratch should inherit installation identity; that is the next
decision. Site 4 wants an answer about whose directory it is before anything is done to it.
