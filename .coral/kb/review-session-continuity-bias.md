# Review Loop Session Continuity Introduces Confirmation Bias

## Rule
In multi-round review loops, Codex reviewers should use fresh sessions each round (no session ID passed), not maintained sessions. The plan file is the single source of truth — fresh reviewers reading the updated file have all needed information without accumulated context bias.

## Why
Session continuity in review loops causes the same bias documented in agents.md's "Fresh Context for Verification" principle. A reviewer that saw Round 1's plan and raised issues is predisposed to accept Round 2's fixes ("I raised it, they fixed it, it's fine") even if the fix is insufficient. A fresh reviewer evaluates the plan on its current merits without prior commitment to any judgment.

This differs from implementation sessions (e.g., Ralph's Codex execution loop) where session continuity IS correct — Codex needs to build on prior work, not re-evaluate it.

## Pattern
```
# WRONG: Session continuity in review loop (biased re-evaluation)
Round 1: codex({ op: "exec", prompt: "review plan" }) → session: "abc"
Round 2: codex({ op: "exec", session: "abc", prompt: "review updated plan" })
         ↑ reviewer remembers Round 1 judgment, confirmation bias

# RIGHT: Fresh session each round (unbiased evaluation)
Round 1: codex({ op: "exec", prompt: "review plan" })
Round 2: codex({ op: "exec", prompt: "review plan" })  # no session — fresh eyes
         ↑ reviewer evaluates current plan without prior-round baggage

# CORRECT use of session continuity: implementation (Ralph)
Round 1: codex({ op: "exec", prompt: "implement X" }) → session: "def"
Round 2: codex({ op: "exec", session: "def", prompt: "continue, also fix Y" })
         ↑ Codex needs prior work context to build on
```

Key distinction: **review** = fresh context per round, **implementation** = maintained context across rounds.
