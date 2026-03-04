# Workflow Prompt Literal: First-Step Discards Initial Prompt
## Rule
When a prompt atom is the first step in a pipeline, the executor passes only `atom.text` to the LLM — the pipeline's `initialPrompt` (the workflow tool's `prompt` field) is intentionally not forwarded. This is asymmetric with agent atoms, which always receive `stepPrompt` (= `initialPrompt` on the first step).
## Why
The design decision: a prompt literal IS the complete instruction. If `initialPrompt` were also forwarded, the LLM would receive both a workflow-level seed prompt and the literal instruction, potentially causing confusion. The literal defines the full task for that step. Middle-step prompt literals DO prepend their text before the previous step's output: `{literal}\n\n{previous output}`.

Without this explicit design — and the code comment at `pipe-executor.ts` — maintainers may accidentally "fix" the first-step case to match agent atom behavior, breaking the intended semantics and tests.
## Pattern
```typescript
// Right: first-step literal uses only atom.text
const promptText = stepIndex === 0
  ? atom.text
  : (stepPrompt ? `${atom.text}\n\n${stepPrompt}` : atom.text);

// Wrong: forwarding stepPrompt on first step
const promptText = stepPrompt ? `${atom.text}\n\n${stepPrompt}` : atom.text;
```
