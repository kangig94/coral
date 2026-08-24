import type { HandoffPublicationIncident, HandoffSuccess } from '../coordinator/handoff-runner.js';
import { formatHandoffPublicationIncident } from './format/handoff-publication.js';

let noticeRendered = false;

/**
 * Goes to stderr, not stdout: the delegated child already wrote the invocation's real answer to the inherited
 * stdout, so appending a line there would corrupt every machine-readable caller (`-f json`, `wait --embed`,
 * hooks that `JSON.parse` the output) the moment a handoff occurred.
 *
 * Writes directly rather than through `emitText` for two reasons: the notice is not a command result, so it
 * must not flush the pending read-store note, and importing `emit.ts` here would close an import cycle —
 * see findProductionStronglyConnectedComponents in tests/invariants/production-import-graph.test.ts.
 */
export function renderHandoffNotice(success: HandoffSuccess): void {
  if (noticeRendered) {
    return;
  }

  noticeRendered = true;
  process.stderr.write(
    `handed off to ${success.version}; this repeats on every run until the installed plugin is upgraded to ` +
      `${success.version} or newer\n`,
  );
}

export function renderHandoffPublicationIncidents(incidents: readonly HandoffPublicationIncident[]): void {
  for (const incident of incidents) {
    process.stderr.write(`${formatHandoffPublicationIncident(incident)}\n`);
  }
}
