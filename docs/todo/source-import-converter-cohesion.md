# TODO — `kb/ops/source/import.ts` holds five concerns at one layer

**Status**: open, and deliberately deferred rather than missed. A PR-gate review recommended the split; the
same review's other findings were fixed in that file, which grew it, so the case is now stronger than when it
was made and the decision is still separable from those fixes.

## What exists

`src/kb/ops/source/import.ts` is 1058 lines and holds:

- read policy and size limits (`deriveSourceImportReadPolicy`, `resolveSourceImportFile`, the admin cap);
- marker device/timeout tuning — GPU detection, per-MiB budgets, env overrides — roughly 180 lines that
  concern one converter's runtime, not source import as a concept;
- generic subprocess primitives that are not source-import-specific at all: `resolveCommandPath`,
  `requireCommandPath`, `runCommand`, `nonAnswerExit`, `CommandLocation`, `commandEnv`;
- four converter classes — `MarkdownCopyConverter`, `HtmlTurndownConverter`, `DocxMammothConverter`,
  `PdfMarkerConverter` — plus the `Converter` interface and `resolveConverter` dispatcher;
- markdown rendering/staging helpers.

The four converter classes share a suffix ("Converter"), not a prefix, and today they are four classes in one
file rather than four sibling files — so this is not literally the case
[`design-philosophy.md`](../../.claude/rules/design-philosophy.md) §7's subdivision trigger names (promoting
an existing cluster of same-prefix sibling *files* to a subdirectory). It is the same shape one layer down:
each class already owns a distinct facet of one bounded responsibility, which is what makes splitting them
into sibling files — and then meeting the real trigger — the natural next step. Nothing enforces this —
per-file line caps were removed when the rewrite landed and growth discipline lives in code review, which is
exactly where it was raised.

## Why it was not done here

The PR that surfaced it was fixing refusal messages, a duplicated three-branch skeleton, and a launch-refused
gap. Extracting `requireCommandPath` was in scope and landed; it brought `install()` (55→49) and `convert()`
(51→47) under the 50-line threshold but did **not** shrink the file — 1043→1058, because the longer,
actionable refusal messages and the 22-line helper outweigh what deduplication saved. That number is the
useful part of this entry: the local fix improved the functions and moved the file the other way, so the file
question is genuinely independent and should not be settled as a side effect of message work.

## Required shape

A `converters/` subdirectory: one file per converter, `converters/index.ts` owning the `Converter` interface
and `resolveConverter`. The generic subprocess primitives move to their own module — they are used only by
`PdfMarkerConverter` today but are written against no source-import concept, and leaving them beside a
converter is what makes them look specific. `import.ts` keeps orchestration, read policy, and staging.

## What would have to be true to start

Nothing external. This is a mechanical move with no contract change, so the only real cost is that it touches
every converter's import path at once and will conflict with any in-flight work in this file. Do it on a
branch that changes nothing else.
