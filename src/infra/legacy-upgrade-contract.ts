/**
 * What a contender's refusal means for its exit. `redundant`: the incumbent already runs this build or a newer one.
 * `deferred`: something that ends on its own, or with the incumbent's natural retirement, holds the upgrade.
 * `error`: a record or build identity this contender cannot read, which nothing it waits on can repair.
 */
export type LegacyUpgradeRefusal = 'redundant' | 'deferred' | 'error';

export type LegacyUpgradeStart =
  | Readonly<{ kind: 'waiting'; requestId: string; supervisorPid: number | null }>
  | Readonly<{ kind: 'handled'; requestId: string; result: Readonly<{ kind: 'completed' | 'closed' }> }>
  | Readonly<{ kind: 'refused'; reason: string; disposition: LegacyUpgradeRefusal }>;
