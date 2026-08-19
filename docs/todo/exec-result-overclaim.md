# TODO — two exec results are read for questions they did not answer

**Status**: open, two members, independent of each other and both small. Found by a PR-gate panel on
`fix/build-identity-per-boot` and left out of that branch because each is a behaviour change that needs its
own argument, not a comment fix. Neither is speculative: both have a sibling in the same file or the same
layer that already takes the opposite, correct disposition, which is what makes them defects rather than
choices.

## Member 1 — `git rev-parse` exit 128 is cached as "this is not a work tree"

`probeIsGitRepo` (`src/kb/curate/git-sync.ts`) ends:

```ts
cachedIsGitRepo = outcome.status === 0;
return cachedIsGitRepo ? 'yes' : 'no';
```

Any answered non-zero status becomes a durable `false` for the daemon's lifetime, and `isGitRepo()`
(`src/kb/curate/git-sync.ts`) gates every git-sync operation on it. `git rev-parse --is-inside-work-tree` exits `128`
for "not a work tree" **and** for dubious ownership, a corrupt `.git`, and anything else git calls fatal.

The same file already refuses that inference for the same evidence. `probeIsGitSyncEnabled`
(`src/kb/curate/git-sync.ts`), on `git remote`'s non-zero exit:

> Measured against real git: … every failure — outside a repository, a corrupted `.git`, anything fatal —
> exits 128 with nothing on stdout. There is no outcome where a non-zero exit means "no remote"; it means git
> refused to answer the question, same as a timeout, so it must not be read as the settled "no" below.

It returns `'unanswered'` and caches nothing. `probeIsGitRepo` reads the same code as a settled negative and
remembers it forever.

The consequence is the one `isGitRepo`'s own docstring (`src/kb/curate/git-sync.ts`) says the function exists to
prevent: "the KB silently ceasing to be version-controlled, with no commit, no push, and nothing said". That
docstring is about caching _non-answers_, which was fixed; caching an answer to a different question produces
the identical outcome and is still there.

## Member 2 — the synchronous port reports a foreign signal as its own timeout

`classifyExecOutcome` (`src/infra/port-types.ts`) has a branch for a child killed by a signal this
process did not ask for, and states its premise in place:

> A null status is a child killed by a signal this process did not ask for (both ports report their own
> timeout as an error instead)

That premise does not hold for the synchronous port. `real.ts`'s `execSync` wrapper substitutes an error for
**every** signalled result before returning: the `ENOBUFS` branch first, then
`if (code === EXEC_TIMEOUT_CODE || result.signal)` (`src/runtime/real.ts`), which stamps
`EXEC_TIMEOUT_CODE` on any remaining signal death. So no synchronous result ever reaches `classifyExecOutcome` with `status: null` and no error, that
branch is unreachable from this port, and a child killed by an operator, an OOM killer, or a supervisor is
reported to every caller as _this port's own timeout_.

Both dispositions land on `kind: 'no-answer'`, so nothing downstream currently branches differently — the
defect is in what the value claims, not yet in what anyone does with it. That is also why it is cheap now and
expensive later: the first caller to sort on `EXEC_TIMEOUT_CODE` to decide whether to extend a deadline will
extend it for a child nothing timed out.

## Why neither was done on the branch that found them

The branch was closing a review round on refusal messages, exit codes and one exec reclassification. Member 1
changes what a cached `false` means for every git-sync operation; member 2 changes what a caller is told about
a class of death the port currently absorbs. Both are defensible and neither is a comment fix, so both were
left rather than folded into a repair pass whose subject was something else.

## What has to be decided

**Member 1 needs a judgement, not just a fix.** `git rev-parse --is-inside-work-tree` genuinely does answer
"no" by exiting 128 in the ordinary not-a-repository case, which is the common one — so folding all of 128
into `'unanswered'` means a directory that really is not a repository is re-probed once per interval forever
rather than answered once. `probeIsGitSyncEnabled` accepted exactly that trade for `git remote` and says so.
Whether the same trade is right here depends on whether a permanent re-probe of a non-repository costs less
than a permanent wrong `false` on a repository whose `.git` is momentarily unreadable. Deciding it is the
work; the code change after it is a few lines.

An alternative worth pricing first: `git rev-parse` distinguishes these on **stderr**, not by exit code
(`fatal: not a git repository` versus `fatal: detected dubious ownership`). Reading stderr for a settled
answer is more evidence than the exit code carries, and less durable than a git flag would be — measure what
git actually prints across the cases before choosing it over the re-probe.

**Member 2 does not need a judgement, and nothing depends on the current behaviour.** The port should not
name a cause it did not observe: a signalled child with no timeout in flight is a non-answer whose detail
says a signal ended it, and only a signal the port itself sent is that port's timeout. The usual risk in
narrowing a code — some caller quietly relying on the broad version — is absent here. `EXEC_TIMEOUT_CODE` has
one reader in the repository, in `kb/ops/source/import.ts`, and it reaches that reader through the
**asynchronous** port, which does not have this defect: it stamps an error only for a kill it scheduled
itself, so a foreign signal arrives as a status-less non-answer exactly as `classifyExecOutcome` describes.
No consumer of the synchronous port reads either exec code at all.
