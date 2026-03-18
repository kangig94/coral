# Discuss Summary Index Must Cover DTO Fields
Promoted: 2026-03-15 | Updated: 2026-03-15
## Rule
When replacing per-session snapshot loads with a persisted discuss summary index, each row must contain every field required by the public summary DTO. For `DiscussSummaryDto`, that means the row must include `agentCount` in addition to the obvious identity and status fields.
## Why
A summary index that omits even one DTO field is not actually authoritative. The first caller that needs the missing field will reintroduce `load(sessionId)` or snapshot replay inside `listSummaries()`, which restores the disk-scan cost the index was supposed to remove and hides the regression behind an apparently successful refactor.
## Pattern
Right:
```ts
type DiscussSummaryRow = {
  sessionId: string;
  projectRoot: string;
  topic: string;
  status: DiscussState['status'];
  createdAt: string;
  agentCount: number;
};

function listSummaries(): DiscussSummaryDto[] {
  return readSummaryRows().map((row) => ({ ...row, authority: 'persisted' }));
}
```

Wrong:
```ts
type DiscussSummaryRow = {
  sessionId: string;
  projectRoot: string;
  topic: string;
  status: DiscussState['status'];
  createdAt: string;
};

function listSummaries(): DiscussSummaryDto[] {
  return readSummaryRows().map((row) => {
    const snapshot = load(row.sessionId); // index no longer owns the listing path
    return buildDiscussSummary(snapshot, 'persisted');
  });
}
```
