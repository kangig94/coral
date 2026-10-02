export type LegacyUpgradeRefusal = 'redundant' | 'deferred' | 'error';

export type LegacyUpgradeStart =
  | Readonly<{ kind: 'waiting'; requestId: string; supervisorPid: number | null }>
  | Readonly<{ kind: 'handled'; requestId: string; result: Readonly<{ kind: 'completed' | 'closed' }> }>
  | Readonly<{ kind: 'refused'; reason: string; disposition: LegacyUpgradeRefusal }>;
