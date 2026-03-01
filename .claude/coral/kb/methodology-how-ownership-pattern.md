# HOW File Ownership: One Agent, One Method, No Cross-References

## Rule
HOW files do not cross-reference each other. Each agent owns exactly one HOW methodology and uses it unconditionally. Consumers (skills, callers) route to the appropriate HOW by choosing which agent to call — they are not directed by the HOW files themselves. Giving one agent two HOW methodologies (even conditionally) causes the agent to confuse when to apply each.

## Why
When HOW-FALSIFY was first created it contained references to HOW-REVIEW ("use HOW-REVIEW if you have a single artifact") and HOW-SYNTHESIZE ("use HOW-SYNTHESIZE if you want to integrate"). This seems helpful but breaks the architecture: the HOW file becomes a router, and agents following it must decide mid-protocol which methodology to switch to. LLMs struggle with conditional methodology selection inside an active protocol. The resolution: remove all cross-references, let consumers make the routing decision before invoking any agent.

## Pattern
**Assignment**:
- `coral:architect` / `coral:critic` → HOW-REVIEW (adversarial review)
- `coral:debugger` → HOW-FALSIFY (competing hypothesis elimination)
- `plan` skill → HOW-SYNTHESIZE + HOW-COMPLETE (feedback synthesis + exit)
- `coral:?` → HOW-RESOLVE (contradiction resolution — future consumer)

**MANDATORY enforcement**: Each agent's prompt says:
> "**MANDATORY**: Before [action], you MUST read `CORAL_METHODS/HOW-XXX.md` and follow its methodology. Never [action] without it."

**Wrong**: HOW-FALSIFY.md contains "Do not use this when there is a single artifact: use HOW-REVIEW instead."
**Right**: HOW-FALSIFY.md contains only "Use this when multiple competing explanations exist." Routing is the caller's responsibility.
