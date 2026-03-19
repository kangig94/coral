# Workflow `context` Field: Shared Cross-Step Atom Context
## Rule
The workflow tool's `context` field (optional string) is prepended to every atom's composed prompt in every step via `launchAtomWithRetry`. It propagates via `executePipeline`'s options bag → `LaunchContext.context` → prompt composition, not by mutating the step loop's `stepPrompt` variable (which is overwritten each step). First-step prompt literals receive `context` but NOT `initialPrompt` — this asymmetry is intentional and documented in `workflow-prompt-literal-first-step-design.md`.
## Why
`stepPrompt` is overwritten each step with the previous step's formatted output. Injecting `context` there would lose it after step 0. Composing inside `launchAtomWithRetry` is the only correct propagation point.

The `LaunchContext` parameter is named `context`, creating a naming collision when extracting the `context?: string` field. Resolve with TypeScript destructuring alias: `context: sharedContext`.
## Pattern
```typescript
// Destructuring alias to avoid collision with the parameter name
const { context: sharedContext, stepPrompt, ... } = context; // context is LaunchContext

// Agent atom composition (order: context → stepPrompt → instruction)
atomPrompt = [sharedContext, stepPrompt, config.instruction].filter(Boolean).join('\n\n');

// Prompt literal (first-step: context + literal only; later-step: context + literal + prev output)
atomPrompt = stepIndex === 0
  ? (sharedContext ? `${sharedContext}\n\n${atom.text}` : atom.text)
  : [sharedContext, atom.text, stepPrompt].filter(Boolean).join('\n\n');

// skills/plan semantic split: shared briefing → context, seed → init_prompt
workflow({
  context: "--deep\n\nReview plan: {path}\nWorking directory: {work_dir}\nSuccess Criteria:\n...",
  init_prompt: "Review the plan.",
  ...
})
```
