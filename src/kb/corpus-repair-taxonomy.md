# Corpus Repair Taxonomy

This document is the Phase 5 authority for corpus-repair incident names, detector signals, classifications, and recovery contracts.
It is intentionally taxonomy-only: no repair code, fixtures, or operational notes belong here.

Classification meanings:
- `auto-fixable`: a deterministic rewrite can restore the invariant without inventing new authority.
- `needs-manual`: more than one plausible authoritative outcome exists, so automation may diagnose but must not choose the content.
- `unrecoverable`: the active corpus must not continue to admit the artifact until a human restores missing authority or removes it from scope.

Detector and contract rules:
- Detector signals are concrete byte scans, regex checks, or structural validations over on-disk corpus files.
- Recovery contracts define the exact post-state invariants required before the incident is considered resolved.
- If resolving one incident reveals another, the new incident must be emitted under its own canonical locus and identifier.

## file-syntax

### conflict-markers

Canonical incident: `file-syntax/conflict-markers`

- Detector signal:
  - Line-oriented byte scan finds any merge marker at line start: `<<<<<<<`, `=======`, or `>>>>>>>`.
  - Canonical regex: `(?m)^(<<<<<<<|=======|>>>>>>>)(?: .*)?$`
- Classification: `needs-manual`
  - Rationale: competing line ranges encode unresolved human intent; choosing one branch automatically is not authority-preserving.
- Recovery contract:
  - Re-running the detector returns zero matches for `(?m)^(<<<<<<<|=======|>>>>>>>)(?: .*)?$`.
  - The file decodes as UTF-8 and represents one linear markdown document, not an unresolved merge splice.
  - The recovered bytes are eligible for downstream frontmatter, identity, and reference checks without merge-marker interference.

### malformed-markdown

Canonical incident: `file-syntax/malformed-markdown`

- Detector signal:
  - Structural scan finds an unmatched fenced-code opener before EOF using fence openers and closers that match `(?m)^(?:```|~~~)[^\r\n]*$`.
  - Or the file contains an ATX header token with no required separating space: `(?m)^#{1,6}\S`.
  - Or the file contains a Setext underline line `(?m)^(=+|-+)\s*$` whose immediately preceding line is blank, absent, or another block delimiter.
- Classification: `needs-manual`
  - Rationale: the fixer cannot safely infer whether to close a fence, rewrite a header, or preserve the literal bytes as body text.
- Recovery contract:
  - A line-oriented fence scan finishes with fence depth `0`; no unmatched opener remains at EOF.
  - No line matches `(?m)^#{1,6}\S`.
  - Every Setext underline line is preceded by exactly one non-blank content line.
  - The file remains parseable as markdown text without this detector firing again.

## frontmatter-shape

### unterminated-yaml

Canonical incident: `frontmatter-shape/unterminated-yaml`

- Detector signal:
  - The file begins at byte offset `0` with a frontmatter opener matching `^---\r?\n`.
  - No closing delimiter line `---` is found before EOF after the opener.
- Classification: `needs-manual`
  - Rationale: once the closing delimiter is missing, the fixer cannot know where YAML ends and markdown body authority begins.
- Recovery contract:
  - If the file uses frontmatter, the only frontmatter block starts at byte offset `0`.
  - That block is delimited by exactly one opening line `---` and exactly one closing line `---` before body markdown begins.
  - Bytes after the closing delimiter are treated as markdown body, not YAML payload.
  - Re-running the detector finds no unterminated frontmatter block.

### yaml-parse-error

Canonical incident: `frontmatter-shape/yaml-parse-error`

- Detector signal:
  - A delimited frontmatter block matching `^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)` is present.
  - Parsing that block with the repository YAML loader throws, or the parsed top-level value is not a mapping.
- Classification: `needs-manual`
  - Rationale: malformed YAML can reflect missing delimiters, invalid scalars, accidental indentation drift, or list/map confusion; automatic repair is not reliably semantics-preserving.
- Recovery contract:
  - The frontmatter block parses without exception under the repository YAML parser.
  - The parsed top-level value is a mapping object, not a scalar, sequence, or null-like malformed structure.
  - Field-level violations, if any remain, surface as `frontmatter-shape/missing-required-fields` or `identity-sequence/*`, not as a parse failure.

### missing-required-fields

Canonical incident: `frontmatter-shape/missing-required-fields`

- Detector signal:
  - Structural validation of a corpus entry resolves any required identity field to missing, null, or empty.
  - Required fields for this incident are `entrySeq`, `slug`, and `title`.
  - `entrySeq` is missing when no parsed frontmatter mapping contains a non-empty `entrySeq` key.
  - `slug` is missing when the active corpus path cannot yield a valid basename-derived slug for the entry kind.
  - `title` is missing when the entry kind's authoritative title surface is absent or empty:
    - note/community: no non-empty top-level `# ...` heading
    - source: no non-empty `title` field in frontmatter
- Classification: `needs-manual`
  - Rationale: repairing a missing identity field would require inventing authority rather than normalizing an already-present value.
- Recovery contract:
  - The entry has a non-empty `slug` equal to the file basename without `.md`, and that slug passes the validator for its directory.
  - The entry has a non-empty trimmed `title` on its authoritative title surface.
  - The entry has a present `entrySeq` field, and that field is eligible to pass `identity-sequence/entryseq-format`.
  - A full entry load succeeds without this detector firing again.

## identity-sequence

### entryseq-collision

Canonical incident: `identity-sequence/entryseq-collision`

- Detector signal:
  - Corpus scan over active note and source entries finds two or more distinct `entryId` values sharing the same positive integer `entrySeq`.
  - Canonical structural check: `groupBy(entrySeq).some(group => group.size > 1)`.
- Classification: `needs-manual`
  - Rationale: the scanner can prove non-uniqueness, but it cannot infer which claimant owns the disputed sequence and which one should move.
- Recovery contract:
  - Every active note and source entry has at most one `entrySeq`.
  - No positive integer `entrySeq` is assigned to more than one active `entryId`.
  - Sorting active entries by `(entrySeq, entryId)` yields a strict total order with no ties on `entrySeq`.

### entryseq-format

Canonical incident: `identity-sequence/entryseq-format`

- Detector signal:
  - The raw frontmatter contains a quoted decimal string such as `entrySeq: "12"` or `entrySeq: '12'`.
  - Or the raw frontmatter contains a leading-zero decimal token such as `entrySeq: 0012`.
  - Or structural validation of the parsed value proves that `entrySeq` is not a canonical positive base-10 integer.
  - Canonical non-canonical regexes:
    - quoted decimal: `/(?:^|\r?\n)\s*entrySeq:\s*(["'])([0-9]+)\1\s*(?:#.*)?(?=\r?\n|$)/`
    - leading zeros: `/(?:^|\r?\n)\s*entrySeq:\s*(0[0-9]+)\s*(?:#.*)?(?=\r?\n|$)/`
- Classification: `auto-fixable`
  - Rationale: this incident is about canonical representation of an already-present sequence value; normalization is safe when the bytes denote one positive integer.
- Recovery contract:
  - The persisted frontmatter encodes `entrySeq` as an unquoted base-10 integer token with regex `(?m)^entrySeq:\s*[1-9][0-9]*\s*$`.
  - Parsing the recovered frontmatter yields a numeric `entrySeq` value of type integer greater than `0`.
  - The normalized numeric value is unchanged from the pre-repair value for quoted-string and leading-zero forms.
  - If the original bytes do not denote exactly one positive integer, the incident must not be auto-fixed and must be reclassified for manual handling before commit.

## reference-integrity

### orphan-entity-graph-refs

Canonical incident: `reference-integrity/orphan-entity-graph-refs`

- Detector signal:
  - `.entity-graph.json` parses, but one or more entry references inside relationship evidence do not resolve to an active corpus entry.
  - Canonical structural check:
    - for each `relationships[*].evidence[*]`, parse as `note:<slug>`, `source:<slug>`, or `community:<slug>`
    - emit the incident when lookup of that `entryId` against the active corpus returns no file-backed entry
- Classification: `auto-fixable`
  - Rationale: removing impossible references is deterministic and does not fabricate corpus authority.
- Recovery contract:
  - Every surviving `relationships[*].evidence[*]` entry ID resolves to an existing active corpus entry at repair commit time.
  - Evidence arrays contain no duplicate entry IDs after repair.
  - Any relationship whose evidence array becomes empty after orphan pruning is removed from `.entity-graph.json`.
  - Re-running the detector returns zero orphan entity-graph references.

### orphan-principle-refs

Canonical incident: `reference-integrity/orphan-principle-refs`

- Detector signal:
  - A note frontmatter `principles` array contains one or more principle slugs for which `principles/<slug>.md` does not exist in the active corpus.
  - Canonical structural check: for each normalized principle slug in note frontmatter, `exists(principlePath(slug)) === false`.
- Classification: `needs-manual`
  - Rationale: automation cannot decide whether to create the missing principle document or remove the note's reference without changing meaning.
- Recovery contract:
  - Every principle slug listed in any note frontmatter resolves to an existing `principles/<slug>.md` file.
  - Principle references remain normalized slugs; no empty or whitespace-only principle token remains.
  - Re-running the detector returns zero orphan principle references.

## Revisions

Phase 5 revision policy:
- One revision is permitted after the initial commit of this document.
- Every revision must append a new log entry in this section; prior entries are immutable.

Revision log:
- `r0` — `2026-04-21` — Initial taxonomy created for Phase 5 AC1.
