# Mandatory thought Field Transforms Discussion Analysis

## Rule
The `thought` field (mandatory since v0.3.8) on every bid captures non-speaking agents' reasoning each round, making the "invisible half" of discussions available for post-analysis. In a 10-round × 5-agent session, 50 thoughts provide far richer data than 10 speeches alone.

## Why
Without thought, only winning speakers leave traces. Silent agents' strategic reasoning — why they bid low, how their positions evolved, whether they deliberately yielded — is lost. The thought field makes bid scores interpretable and enables round-by-round reconstruction of the full deliberation process.

## Pattern
Key capabilities enabled:
- **Strategic intent**: Why an agent bid 30 vs 80 — the number alone is ambiguous
- **Thought evolution**: Tracking how a silent agent's position developed over 6 rounds before finally speaking
- **Deliberate yielding**: Distinguishing "nothing to say" from "strategically waiting"
- **Post-discussion analysis**: Reconstructing each round's full cognitive landscape, not just the winner's speech
