/** Recovery notice constants — shared by recovery-core (classifier) and lifecycle (consumer). */

export const OLD_FORMAT_NOTICE =
  'Incompatible job format — missing durable launch record. Job predates the handoff recovery system.';
export const GHOST_LAUNCH_NOTICE =
  'Launch record exists but runtime.json was never written. The durable wrapper did not start successfully.';
