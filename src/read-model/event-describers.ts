// Composes the default `EventDescriberMap` consumed by causality's cause-ref
// renderer. Each domain owns its own describers; this module is the single
// composition site that joins them. Lives in `read-model/` because composing
// cross-domain read vocabulary is the read-model layer's purpose, mirroring
// how `CoralStore` joins per-domain queries.

import type { EventDescriberMap } from '../causality/render.js';
import { discussEventDescribers } from '../discuss/event-describers.js';
import { jobsEventDescribers } from '../jobs/event-describers.js';
import { sessionsEventDescribers } from '../sessions/event-describers.js';
import { workflowEventDescribers } from '../workflow/event-describers.js';
import { CoralSetupError } from '../runtime/errors.js';

export const defaultEventDescribers: EventDescriberMap = new Map([
  ...jobsEventDescribers,
  ...sessionsEventDescribers,
  ...discussEventDescribers,
  ...workflowEventDescribers,
]);

/**
 * Spec §7.1 + §13.1: every Journal event type can appear as a `causeRef`
 * target, so every type registered in a domain's `events.ts` must have a
 * matching describer keyed `${streamKind}:${type}`. A producer that
 * constructs a causeRef to an event without a registered describer renders
 * as the bare type name at runtime — operator-invisible drift.
 *
 * Called from coordinator boot before any IPC/HTTP comes up so missing
 * coverage surfaces as a structured `describer_missing` setup error rather
 * than a silent rendering degradation.
 */
export function assertDescriberCoverage(
  describerKeys: readonly string[],
  describers: EventDescriberMap = defaultEventDescribers,
): void {
  const missing: string[] = [];
  for (const key of describerKeys) {
    if (!describers.has(key)) {
      missing.push(key);
    }
  }
  if (missing.length === 0) {
    return;
  }
  throw new CoralSetupError({
    code: 'describer_missing',
    userMessage: `Event describer missing for: ${missing.join(', ')}.`,
    remediation:
      'Add an entry to the owning domain\'s event-describers.ts and re-export it from read-model/event-describers.ts.',
    context: { missing },
  });
}
