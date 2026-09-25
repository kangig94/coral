export type LegacyUpgradeStart =
  | Readonly<{ kind: 'waiting'; requestId: string; waiter: Readonly<{ kind: 'started' | 'existing'; pid: number }> }>
  | Readonly<{ kind: 'deferred'; requestId: string; reason: string }>
  | Readonly<{ kind: 'refused'; reason: string }>;
