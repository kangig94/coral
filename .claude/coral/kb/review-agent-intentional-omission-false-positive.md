# Review Agents Flag Intentional Schema Omissions as Bugs

## Rule
Automated review agents (simplify, quality review) treat every schema inconsistency as an error. When a finding conflicts with a dedicated test that asserts the inconsistency is intentional, the test wins — revert the "fix" and record the false positive.

## Why
During a simplify pass, the quality agent flagged `_8_synthesize` missing from the `discuss_lead` inputSchema op enum as a schema/implementation inconsistency (HIGH severity). The fix was applied — and then the test suite failed immediately, because `server-handlers.test.ts` contains:
```ts
it('should intentionally omit _8_synthesize from discuss_lead inputSchema enum', () => {
  expect(inputSchema.properties.op?.enum).not.toContain('_8_synthesize');
});
```
The omission is a deliberate visibility control pattern (`mcp-inputschema-op-visibility-control.md`): keeping an op out of the enum prevents LLM agents from discovering and calling it prematurely, while Zod still routes it correctly when called by callers that know about it.

## Pattern
Before applying a "fix" suggested by a review agent:
1. Run the test suite — a dedicated test asserting the current behavior is proof of intent.
2. Check `kb/mcp-inputschema-op-visibility-control.md` — op enum omissions in coral are often deliberate ACL substitutes.
3. If a test explicitly asserts the "incorrect" behavior, classify the review finding as false positive and move on.

The test name "should **intentionally** omit..." is the signal. Review agents lack this context.
