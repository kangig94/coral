# HOW File Ownership: Primary + Conditional, No Cross-References

## Rule
HOW files do not cross-reference each other. Each agent owns one primary HOW methodology read unconditionally.
An agent may own one additional conditional HOW that activates only when the primary protocol detects a specific trigger.
The conditional method is an escalation within the primary protocol, not an independent methodology selection.
Consumers (skills, callers) route to the appropriate HOW by choosing which agent to call — they are not directed by the HOW files themselves.

## Why
When HOW-FALSIFY was first created it contained references to HOW-REVIEW ("use HOW-REVIEW if you have a single artifact") and HOW-SYNTHESIZE ("use HOW-SYNTHESIZE if you want to integrate"). This seems helpful but breaks the architecture: the HOW file becomes a router, and agents following it must decide mid-protocol which methodology to switch to. LLMs struggle with independent methodology selection inside an active protocol. Escalation-triggered conditionals (where the primary protocol defines the trigger, not the conditional HOW) avoid this confusion because the agent follows a single protocol that can escalate — it never chooses between methodologies.

## Pattern
**Assignment**:
- `coral:architect` / `coral:critic` → HOW-REVIEW (adversarial review)
- `coral:debugger` → HOW-FALSIFY (competing hypothesis elimination)
- `coral:resolver` → HOW-SYNTHESIZE (primary) + HOW-RESOLVE (conditional: on Constraint Collision)
- `plan` skill → HOW-COMPLETE (exit evaluation only)

**MANDATORY enforcement**: Each agent's prompt says:
> "**MANDATORY**: Before [action], you MUST read `CORAL_METHODS/HOW-XXX.md` and follow its methodology. Never [action] without it."

**Wrong**: HOW-FALSIFY.md contains "Do not use this when there is a single artifact: use HOW-REVIEW instead."
**Right**: HOW-FALSIFY.md contains only "Use this when multiple competing explanations exist." Routing is the caller's responsibility.

**Conditional ownership**: resolver reads HOW-SYNTHESIZE unconditionally.
When Constraint Collision is detected during synthesis, resolver reads HOW-RESOLVE as escalation.
This is acceptable: the trigger is defined by the primary protocol, not by HOW-RESOLVE itself.
