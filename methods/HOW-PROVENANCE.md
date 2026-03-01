# HOW to Verify Evidence Provenance

> **CORAL_METHODS**: `~/.claude/plugins/cache/coral/**/methods/` — locate via Glob

A citation is a delegation of trust. An unverified citation dresses hallucination in the robes of authority.
In the LLM context this is especially dangerous — nonexistent files, wrong line numbers, and
out-of-context quotations grant confidence to analyses that never read the actual code.
An agent that cites without verifying is indistinguishable from an agent that fabricates.

## Evidence Types

| Type | Definition | Verification Method | Confidence Anchor |
|------|-----------|--------------------|--------------------|
| Code trace | Direct reading of file:line content | Read tool confirms actual content | Does the content support the claim? |
| Test behavior | Result of executing a test | Actual test output checked | Does the test directly verify the claim? |
| Git history | Causal reasoning from commit history | git log/blame confirms timeline | Do change timing and symptoms align? |
| Structural inference | Dependency/call chain analysis | Grep/Glob traces structure | Is each inference step individually verifiable? |
| Assumption | Unstated premise | Cannot be verified — must be marked explicitly | What observation would refute this assumption? |

## Verification Chain Protocol

### Step 1: Claim Decomposition
Decompose each claim into (subject, predicate, evidence source).
"Function X returns null" → subject: X, predicate: returns null, source: which file:line?

### Step 2: Source Resolution
Verify the evidence source actually exists.
- Confirm the file exists
- Confirm the line range is within the file's length
- If file or line range is invalid → `status: unverified`

### Step 3: Content Alignment
Verify the source's actual content supports the claim.
If you claim "this code does X", read it and confirm it actually does X.
If the claim only partially matches → `status: partial`

### Step 4: Context Preservation
Verify the source is not cited out of context.
"This function returns an error" — under what conditions? Always? Only for certain inputs?
Citing a conditional fact unconditionally → `status: partial`

## Verification Status

Assign a verification status to each evidence item:

| Status | Meaning | Action |
|--------|---------|--------|
| `verified` | Source resolved + content aligned + context preserved | Use as-is |
| `partial` | Source resolved but content alignment or context unconfirmed | Flag with caution, recommend further verification |
| `unverified` | Source unresolved or assumption-based | Must be marked explicitly; never use alone as basis for conclusions |

## Tagging Output
Tag each finding with evidence type + verification status:
`[provenance: code trace, status: verified, methods/HOW-REVIEW.md:74]`

## Failure Modes
- **Phantom reference**: Citing a file or line that does not exist → caught at Step 2
- **Context stripping**: Citing a conditional fact as unconditional → caught at Step 4
- **Transitive trust**: "A cites B which cites C" — A trusts C without direct verification
- **Stale reference**: Code has changed but citation is based on a prior state
