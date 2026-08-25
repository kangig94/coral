import {
  type HandoffRoutingInvocationStatus,
  type HandoffRoutingStatusReadResult,
  type RetirementHistoryTruncated,
} from '../../src/coordinator/handoff-routing-status.js';
import { HANDOFF_ROUTING_STATUS_GENERATION } from '../../src/store/handoff-routing-status-store.js';

declare const statuses: readonly HandoffRoutingInvocationStatus[];
declare const retirementHistoryTruncated: RetirementHistoryTruncated;

[
  { kind: 'absent' },
  {
    kind: 'current',
    generation: HANDOFF_ROUTING_STATUS_GENERATION,
    statuses,
    retirementHistoryTruncated,
  },
  { kind: 'unreadable', reason: 'invalid-json' },
  { kind: 'unreadable', reason: 'invalid-shape' },
  { kind: 'unreadable', reason: 'too-large' },
  { kind: 'unsupported-generation', generation: HANDOFF_ROUTING_STATUS_GENERATION + 1 },
  { kind: 'undeterminable', cause: 'io-failed', errcode: 5 },
] satisfies readonly HandoffRoutingStatusReadResult[];

({
  kind: 'current',
  generation: HANDOFF_ROUTING_STATUS_GENERATION,
  // @ts-expect-error SQLite allocates each record sequence; there is no speculative high-water state.
  sequenceHighWater: 0,
  statuses,
  retirementHistoryTruncated,
}) satisfies HandoffRoutingStatusReadResult;

// @ts-expect-error A single transactional SQLite address has no recovery artifact that can conflict.
({ kind: 'unreadable', reason: 'recovery-conflict' }) satisfies HandoffRoutingStatusReadResult;
