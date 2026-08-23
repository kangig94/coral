import {
  HANDOFF_ROUTING_STATUS_GENERATION,
  type HandoffRoutingInvocationStatus,
  type HandoffRoutingStatusReadResult,
  type RetirementHistoryTruncated,
} from '../../src/coordinator/handoff-routing-status.js';

declare const statuses: readonly HandoffRoutingInvocationStatus[];
declare const retirementHistoryTruncated: RetirementHistoryTruncated;

[
  { kind: 'absent' },
  {
    kind: 'current',
    generation: HANDOFF_ROUTING_STATUS_GENERATION,
    sequenceHighWater: 0,
    statuses,
    retirementHistoryTruncated,
  },
  { kind: 'unreadable', reason: 'invalid-json' },
  { kind: 'unreadable', reason: 'invalid-shape' },
  { kind: 'unreadable', reason: 'too-large' },
  { kind: 'unreadable', reason: 'recovery-conflict' },
  { kind: 'unsupported-generation', generation: HANDOFF_ROUTING_STATUS_GENERATION + 1 },
] satisfies readonly HandoffRoutingStatusReadResult[];
