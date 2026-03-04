# Workflow Atoms: Separate XML Output Tags from Diagnostic Labels
## Rule
When multiple atoms of the same "type" can appear in a parallel step (e.g., multiple prompt literals each tagged `<step-result>`), the XML output tag and the runtime diagnostic label must be separate fields. Reusing the XML tag as the diagnostic label makes concurrent failures opaque: `step 1 atom step-result busy` is unactionable, and a parallel step with two prompt literals produces two identical `<step-result>` progress lines with no way to distinguish them.
## Why
`LaunchedAtom.agent` (the diagnostic label) is used in progress messages, error messages, and `readAtomOutput` error context. `LaunchedAtom.tagName` is used only in `formatStepOutput` to wrap output in XML. These serve completely different audiences: the diagnostic label is for operators debugging a pipeline; the XML tag is for downstream LLM steps parsing structured output.

Without the split, either: (a) operators get useless `step-result` labels in every log line, or (b) downstream steps see non-standard tag names derived from diagnostic identifiers.
## Pattern
```typescript
// LaunchedAtom has both fields
export type LaunchedAtom = {
  agent: string;    // diagnostic: 'architect', 'prompt#1(summarize...)'
  tagName: string;  // XML output: 'architect', 'step-result'
  ...
};

// Helper functions separate the concerns
function atomTagName(atom: PipeAtom): string {
  return atom.kind === 'prompt' ? 'step-result' : atom.agent;
}
function atomDiagnosticLabel(atom: PipeAtom, atomIndex: number): string {
  if (atom.kind === 'agent') return atom.agent;
  const truncated = atom.text.length > 20 ? `${atom.text.slice(0, 20)}...` : atom.text;
  return `prompt#${atomIndex + 1}(${truncated})`;
}
```
