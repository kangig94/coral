# Closed — repository ignore patterns are anchored to their intended scope

**Status**: closed 2026-08-31. The rule recorded here is broader than the original
`*.coral-*.tmp` example: a gitignore pattern with no `/` matches at any depth below the
file in which it appears. Moving an unchanged pattern to a wider-scope ignore file can
therefore widen what Git hides even when the literal itself does not change.

## Decision

Coral no longer adds `*.coral-*.tmp` to a project `.claude/.gitignore`. New replacement
staging belongs in a Git-metadata or Coral-state arena, and the unreleased working-tree
staging pattern was deleted rather than migrated or re-anchored.

The surviving `.claude/coral` rule moved from the project `.claude/.gitignore` to
`.git/info/exclude`. Its canonical form is the literal-escaped project-relative path with
a leading `/`: `/.claude/coral` for a project at the repository root, or the corresponding
anchored path for a nested project. The slash prevents the broader exclude file from
matching another `coral` path elsewhere in the repository; escaping keeps literal `*`,
`?`, `[` and `]` characters in project-directory names from becoming pattern syntax.

## Precedence consequence

`.git/info/exclude` has lower precedence than a working-tree `.gitignore`. A deliberate
`!coral` in `.claude/.gitignore` therefore wins and can expose `.claude/coral`. This is an
accepted consequence of keeping Coral's generated rule out of the working tree.

The close-out preserves the governing constraint: choose the pattern's anchor from the
scope of the file that owns it, not from the scope of the file where the pattern used to
live.

## Legacy staging deletion authority

The repository owner accepted deletion of an age-eligible regular file when its name and
location exactly match either legacy `.gitignore.coral-<pid>-<timestamp>.tmp` shape. That
authority does not require proof that a writer has exited. The symlink staging shape has
no such exception: it must still point into Coral's `~/.coral/projects*` state before it
may be deleted.

This is a deliberate mixed-version shortfall. Versions 0.10.6 through 0.10.9 can create
one of the regular-file names without participating in the current maintenance lock, so
a 30-second-old file can still belong to a live older writer. If cleanup wins the race,
that writer refuses visibly instead of publishing through the removed name; if
publication wins, cleanup no longer finds the staging name. The override accepts that
interference so rollback cannot leave legacy working-tree staging permanently, while
retaining exact name, location, type, and age as the deletion boundary.
