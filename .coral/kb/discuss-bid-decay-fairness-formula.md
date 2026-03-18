# Bid Decay Formula for Discuss Fairness

## Rule
Apply a history-based bid decay after bid collection and before winner resolution to prevent dominant bidders from monopolizing turns. Formula: `effective = raw + (100/N) * (avg_speaks - my_speaks) - (50/N) * just_spoke`, where N is participant count. Use avg-based (not min-based) speaks delta.

## Why
Without decay, high raw bidders can win consecutive turns. In observed sessions, critical unfairness moments were decided by just 2 points. The 100/N coefficient provides ~6x safety margin against LLM bid non-determinism. A min-based model becomes inert when all agents have equal speaks (penalty=0), allowing the highest raw bidder to dominate again. The avg-based model stays active because any speaker immediately goes above average.

## Pattern
```
# Two components:
# 1. Speaks imbalance: boosts under-speakers, penalizes over-speakers
# 2. Recency: prevents consecutive wins when speaks are equal

effective = raw + (100/N) * (avg_speaks - my_speaks) - (50/N) * just_spoke

# RIGHT: avg-based — always active, speaker immediately goes above avg
# WRONG: min-based — inert when all agents have equal speaks (penalty=0)
```

Complements (not replaces) the existing quota system. Apply after bid collection, before winner resolution.
