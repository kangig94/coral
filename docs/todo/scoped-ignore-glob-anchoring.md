# TODO — the scoped ignore glob is broader than the files it was written for

**Status**: open, and this one is a decision rather than an investigation. The finding is small, the fix is
known, and the reason it was left is a cost that only a person should weigh. Raised and deliberately declined
during the PR-gate repairs on `fix/build-identity-per-boot`.

## What exists

`ensureScopedIgnore` (`clients/hooks/lib/project-ignore.mjs`) maintains two exact lines in the
project's `.claude/.gitignore`:

```js
const CORAL_IGNORE_ENTRY = 'coral';
const CORAL_IGNORE_TEMP_ENTRY = '*.coral-*.tmp';
```

The second exists for the temp files Coral's own atomic writes leave behind if interrupted. There are exactly
two of them, and both sit directly in the directory the pattern is written into:

- `${path}.coral-${token}.tmp` — `atomicTransform`'s staging file (`clients/hooks/lib/project-ignore.mjs`)
- `${link}.coral-${token}.tmp` — the symlink swap's staging name (`clients/hooks/lib/project-ignore.mjs`)

A gitignore pattern with no `/` matches at **any depth** below the file it is written in. So the line covers
both writers and also any file anywhere under `.claude/` whose name happens to contain `.coral-` followed by
`.tmp`. Anchoring it — `/*.coral-*.tmp` — would restrict it to the directory the two writers actually use.

## Why it was left

`.claude/.gitignore` is a user-owned file, checked into the user's repository, and this line has already
shipped into it. `hasExactLine` and `appendExactLine` (both in `clients/hooks/lib/project-ignore.mjs`) match the literal string, so
changing the literal does not update the old line — it adds a second one beside it and leaves the first there
forever.

A retirement mechanism for exactly this does exist in the same file: `maintainProjectIgnore` removes the
retired root entry with `removeExactLines(content, context.legacyEntry)` (`clients/hooks/lib/project-ignore.mjs`), gated on
`hasExactLine` finding it first. So the claim that anchoring has "no migration path" is wrong — the
path is there and is the one this file already uses. The real cost is different and smaller: every existing
installation pays one more read-modify-rename of `.claude/.gitignore` on the SessionStart that first sees the
retired line, and the retirement branch stays in the code afterwards for as long as any un-migrated checkout
might appear.

## What has to be decided

Whether an over-broad ignore under `.claude/` is worth that. The two sides:

- **Leave it.** The pattern only over-matches a file whose name contains `.coral-…​.tmp`, under a directory
  that holds tool configuration rather than a user's source. Nobody has reported one. The line is correct for
  every file Coral actually writes.
- **Anchor it.** A generated ignore rule that silently hides a file its author never wrote is the kind of
  thing found long after it costs something, and the migration this file already performs for its own retired
  entry is the precedent for doing it cleanly rather than accumulating.

There is no correctness argument on either side — both behaviours are defensible, which is why this is
recorded rather than fixed. If it is taken, take it with the `LEGACY_CORAL_IGNORE_ENTRY` mechanism rather
than a new one, and add the retired literal to the same removal pass rather than a second.
