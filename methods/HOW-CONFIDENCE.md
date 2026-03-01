# HOW to Grade Evidence Confidence

> **CORAL_METHODS**: `Glob(pattern: "**/methods/", path: "~/.claude/plugins/cache/coral/")`
> Pass `~` literally to the Glob tool — it expands to the home directory. Do not resolve it yourself.

A conclusion without calibrated confidence is bluster; excessive uncertainty is paralysis.
From GRADE (Grading of Recommendations Assessment, Development, and Evaluation):
evidence quality is a function of starting point and adjustment factors.
The strength of a conclusion must be proportional to the quality of its evidence.
One strong piece of evidence outweighs many weak ones — but never reaches HIGH alone.

## Confidence Tiers

| Tier | Meaning | Decision Implication |
|------|---------|---------------------|
| HIGH | Multiple independent evidence lines converge; direct evidence | Act on the conclusion |
| MODERATE | Single direct evidence or multiple indirect | Adopt the conclusion but monitor for counterexamples |
| LOW | Inference-based, single source, alternatives possible | Tentatively adopt; recommend further investigation |
| VERY LOW | Assumption-based, no direct evidence | Treat as hypothesis; verification required before action |

## Starting Point
Determined by evidence type (from HOW-PROVENANCE):
- Code trace / Test behavior → MODERATE start (single source cannot reach HIGH)
- Git history → LOW start
- Structural inference → LOW start
- Assumption → VERY LOW start

**Core principle**: A single source can reach MODERATE at most. HIGH requires triangulation (≥2 independent evidence lines converging).

## Downgrade Factors (each −1 tier)

| Factor | Question | Example |
|--------|----------|---------|
| Inconsistency | Do evidence lines contradict each other? | Code does X but tests expect Y |
| Indirectness | Is evidence from a different context applied here? | Reasoning by analogy from a similar module |
| Imprecision | Does the evidence permit multiple interpretations? | Log shows error but cause is ambiguous |
| Bias risk | Did the evidence gatherer expect a particular result? | Reviewing your own code |

## Upgrade Factors (each +1 tier; only from LOW/VERY LOW)

| Factor | Question | Example |
|--------|----------|---------|
| Convergence | Do independent evidence lines point to the same conclusion? | Code analysis, tests, and git history all identify the same bug |
| Directness | Is the evidence from exactly this context? | Reproducing the bug by running the problem code directly |
| Replication | Does a different approach reach the same conclusion? | Static analysis and dynamic testing both find the same flaw |

## Grading Algorithm

Apply in strict order — changing the order may change the result:

```
Phase A — Individual evidence line evaluation (applied independently to each line):
  1. Determine starting tier from evidence type (see Starting Point)
  2. Apply downgrade factors: −1 tier per applicable factor
  3. Floor: cannot go below VERY LOW
  → Result: individual tier for each evidence line

Phase B — Evidence line combination (each step's input = previous step's output):
  4. Cross-inconsistency check: if Phase A results contain contradicting lines,
     apply −1 to the combined tier (applied to the final combined tier, not individuals)
  5. Single evidence line: ceiling MODERATE
  6. ≥2 independent lines converge (triangulated): highest individual tier +1 → combined tier (max HIGH)
  7. Upgrade factors (applied directly to combined tier):
     Qualification: at least one Phase A individual tier was LOW/VERY LOW.
     Target: the combined tier. +1 per applicable factor (convergence/directness/replication).
     (Individual lines are NOT recomputed — Phase A results are referenced for qualification only)
  8. Final ceiling: cannot exceed HIGH. Single source cannot exceed MODERATE.
```

Tier ordering: VERY LOW < LOW < MODERATE < HIGH.
**Execution order determines result**: Phase A (individual downgrade) → Phase B Step 4 (cross-inconsistency) →
Steps 5-6 (combine/triangulation) → Step 7 (upgrade) → Step 8 (final ceiling).
Each step uses the previous step's output as input; changing the order changes the result.

## Triangulation Protocol
Mark as triangulated when ≥2 independent evidence lines converge.
Independence criterion: evidence collected by different tools, different perspectives, or at different times.
Mixed-source rule: code trace + structural inference converging → combined tier may exceed individual tiers.

## Tagging Output
Tag each finding with confidence tier:
`[confidence: MODERATE, downgraded: indirectness]`

## Failure Modes
- **Overconfidence**: Assigning HIGH from a single code reading without testing or execution
- **Anchoring**: Over-fixating on the first piece of evidence while ignoring subsequent evidence
- **Confidence laundering**: Using low-confidence findings as the basis for high-confidence conclusions
- **Triangulation theater**: Counting derivatives of the same source as independent evidence
