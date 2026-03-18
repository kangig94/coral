# Workflow Preservation Needs a Stable Marker on Failure
## Rule
When a workflow preserves intermediate outputs, do not use success-only step metadata as the only workflow identity marker. Terminal workflow results must carry a stable workflow marker on both success and failure, including shutdown/orphan recovery paths that synthesize terminal results from persisted job state, and partial completed outputs must survive error paths. Persist durable workflow identity in status (for example `jobKind: 'workflow'`) so non-executor terminalization can still emit `workflow: { steps: [] }`. Atom accumulation must use a stable identity such as `jobId` or `{stepIndex, atomIndex, kind, provider}` rather than a human-readable label that can collide.

## Why
If the bridge identifies workflows by `steps` only when the workflow succeeds, failed workflows silently fall back to single-job wait behavior and lose the preserved outputs that matter most for debugging and audit. The risk increases in legal parallel workflows where prompt literals share the XML tag `step-result` and same agent names may appear under different providers. A label-keyed accumulator can swap or overwrite outputs, a success-only workflow marker makes the bridge return the wrong shape exactly on failure, and shutdown/orphan recovery will emit generic error terminals unless workflow identity is already durable in persisted job state.

## Pattern
```typescript
// WRONG: success metadata doubles as workflow identity
type TerminalResult = {
  content: string;
  steps?: Array<{ agent: string; step: number; line: number; endLine: number }>;
};

const isWorkflow = Array.isArray(event.result.steps);
const results = new Map<string, string>(); // keyed by human label
results.set(atom.agent, event.result.content);
```

```typescript
// RIGHT: explicit workflow marker, durable workflow job identity, plus stable atom identity
type WorkflowStepMeta = {
  agent: string;   // human label
  step: number;
  atom: number;
  provider: string;
  start: number;   // first content line in result.md
  end: number;     // last content line in result.md
};

type TerminalResult = {
  content: string;
  notice?: string;
  workflow?: { steps: WorkflowStepMeta[] };
};

type PersistedStatusRecord = {
  jobKind?: 'provider' | 'workflow';
};

const isWorkflow = event.result.workflow !== undefined;
const isWorkflowJob = status.jobKind === 'workflow';
const results = new Map<string, string>(); // keyed by jobId
results.set(atom.jobId, event.result.content);
```
