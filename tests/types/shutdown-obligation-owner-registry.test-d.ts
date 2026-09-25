import {
  createShutdownSettlementLedger,
  type ShutdownObligation,
  type ShutdownSettlementLedgerOptions,
} from '../../src/coordinator/shutdown-settlement.js';
import { SHUTDOWN_OBLIGATION_OWNERS } from '../../src/coordinator/succession/obligations.js';

type AssertNever<Value extends never> = Value;
type ClosedLabels = AssertNever<string extends ShutdownObligation['label'] ? string : never>;
type DynamicLabel = `stream response close ${number}` | `provider proxy lifecycle fatal incident${'' | ` ${number}`}`;
type RegistryKey =
  | Exclude<ShutdownObligation['label'], DynamicLabel>
  | 'stream response close'
  | 'provider proxy lifecycle fatal incident';
type MissingRegistryKeys = AssertNever<Exclude<RegistryKey, keyof typeof SHUTDOWN_OBLIGATION_OWNERS>>;
type UnknownRegistryKeys = AssertNever<Exclude<keyof typeof SHUTDOWN_OBLIGATION_OWNERS, RegistryKey>>;

void (0 as ClosedLabels);
void (0 as MissingRegistryKeys);
void (0 as UnknownRegistryKeys);

// @ts-expect-error a new obligation requires an owner registry entry.
type AddedObligationIsCovered = AssertNever<Exclude<'new', keyof typeof SHUTDOWN_OBLIGATION_OWNERS>>;
void (0 as AddedObligationIsCovered);

declare const options: ShutdownSettlementLedgerOptions;
declare const obligation: Omit<ShutdownObligation, 'label'>;
const ledger = createShutdownSettlementLedger(options);

// @ts-expect-error the shutdown ledger cannot accept an obligation outside the owner registry.
void ledger.run({ ...obligation, label: 'new' });
