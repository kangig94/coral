// Canonical setup-error registry. Holds the cross-cutting CoralSetupError
// class together with its documented code catalog. Per Principle #7, an error
// code catalog is a *registry of typed identifiers* — a single canonical home
// is the right shape (analogous to HTTP status codes, POSIX errno, SQLSTATE).
// "magnet" anti-pattern only applies to files that absorb unrelated *logic*
// (helpers.ts, utils.ts); a registry growing as new codes land is the
// expected shape of a canonical home, not drift.

import { isRecord } from '../infra/json.js';

export interface CoralSetupErrorInit {
  code: string;
  userMessage: string;
  remediation: string;
  context?: Record<string, unknown>;
}

export type CoralSetupErrorContext = Record<string, unknown>;
export type SerializedCoralSetupError = CoralSetupErrorInit;

export type DocumentedCoralSetupErrorCode =
  | 'equipment_install_lock_contended'
  | 'equipment_binary_corrupt'
  | 'installer_payload_invalid'
  | 'unknown_equipment'
  | 'equipment_runtime_unavailable'
  | 'equipment_embedding_provider_missing'
  | 'consumer_not_registered'
  | 'consumer_authority_mismatch'
  | 'consumer_interest_mismatch'
  | 'consumer_registration_kind_mismatch'
  | 'consumer_lane_invalid'
  | 'consumer_wait_unsupported'
  | 'consumer_unregister_requires_stop'
  | 'consumer_interest_invalid'
  | 'consumer_registration_kind_invalid'
  | 'equipment_slot_not_declared'
  | 'slot_already_equipped'
  | 'equipment_install_path_unwritable';

type DocumentedCoralSetupErrorSpec = {
  readonly userMessage: string | ((context?: CoralSetupErrorContext) => string);
  readonly remediation: string | ((context?: CoralSetupErrorContext) => string);
};

function stringContextValue(context: CoralSetupErrorContext | undefined, key: string, fallback: string): string {
  const raw = context?.[key];
  return typeof raw === 'string' && raw.trim().length > 0 ? raw : fallback;
}

const DOCUMENTED_CORAL_SETUP_ERRORS = {
  equipment_install_lock_contended: {
    userMessage: (context) =>
      `Another coral-cli expansion equip is in progress for ${stringContextValue(context, 'name', 'this equipment')}.`,
    remediation: 'Wait for the in-flight install to complete or remove the stale lock file.',
  },
  equipment_binary_corrupt: {
    userMessage: (context) =>
      `The installed binary for ${stringContextValue(context, 'name', 'this equipment')} could not be activated.`,
    remediation: (context) =>
      `Run 'coral-cli expansion unequip ${stringContextValue(context, 'name', 'needle')}' before retrying 'coral-cli expansion equip ${stringContextValue(context, 'name', 'needle')}'.`,
  },
  installer_payload_invalid: {
    userMessage: 'Expansion installer returned an invalid payload.',
    remediation: 'Retry the command. If this persists, report the code because the installer response failed internal validation.',
  },
  unknown_equipment: {
    userMessage: (context) =>
      `The equipment ${stringContextValue(context, 'name', 'this equipment')} is not registered in the Coral catalog.`,
    remediation: "Run 'coral-cli expansion list' to see available equipment.",
  },
  equipment_runtime_unavailable: {
    userMessage: (context) =>
      `Equipment runtime is not available for ${stringContextValue(context, 'name', 'this equipment')}.`,
    remediation: (context) =>
      `Restart Coral or run 'coral-cli expansion equip ${stringContextValue(context, 'name', 'needle')}' to retry.`,
  },
  equipment_embedding_provider_missing: {
    userMessage: (context) =>
      `${stringContextValue(context, 'name', 'This equipment')} needs an embedding provider before it can be equipped.`,
    remediation: (context) =>
      `Set CORAL_EMBEDDING_PROVIDER in ~/.coral/.env (and any required companion variables) before retrying 'coral-cli expansion equip ${stringContextValue(context, 'name', 'needle')}'.`,
  },
  consumer_not_registered: {
    userMessage: (context) =>
      `Consumer ${stringContextValue(context, 'id', 'this consumer')} is not registered with the coordinator.`,
    remediation: 'Re-equip or verify the consumer registration.',
  },
  consumer_authority_mismatch: {
    userMessage: (context) =>
      `Consumer ${stringContextValue(context, 'id', 'this consumer')} authority mismatch: expected ${stringContextValue(context, 'expected', 'unknown')}, got ${stringContextValue(context, 'actual', 'unknown')}.`,
    remediation: 'Verify consumer registration ordering and authority.',
  },
  consumer_interest_mismatch: {
    userMessage: (context) =>
      `Consumer ${stringContextValue(context, 'id', 'this consumer')} interest mismatch.`,
    remediation: 'Verify consumer interest declaration matches the registration.',
  },
  consumer_registration_kind_mismatch: {
    userMessage: (context) =>
      `Consumer ${stringContextValue(context, 'id', 'this consumer')} registration kind mismatch: expected ${stringContextValue(context, 'expected', 'unknown')}, got ${stringContextValue(context, 'actual', 'unknown')}.`,
    remediation: 'Check that registration kind (base vs equipment) is consistent.',
  },
  consumer_lane_invalid: {
    userMessage: (context) =>
      `Consumer ${stringContextValue(context, 'id', 'this consumer')} lane is invalid.`,
    remediation: 'Verify lane configuration against registration.',
  },
  consumer_wait_unsupported: {
    userMessage: (context) =>
      `Consumer ${stringContextValue(context, 'id', 'this consumer')} does not support wait.`,
    remediation: 'Consumer does not support fresh-wait; use status polling.',
  },
  consumer_unregister_requires_stop: {
    userMessage: (context) =>
      `Consumer ${stringContextValue(context, 'id', 'this consumer')} must be stopped before unregister.`,
    remediation:
      'Consumer must be stopped before unregister; this is an internal sequencing error. Report it with the code if persistent.',
  },
  consumer_interest_invalid: {
    userMessage: (context) =>
      `Consumer ${stringContextValue(context, 'id', 'this consumer')} interest is invalid.`,
    remediation: 'Verify consumer interest declaration structure.',
  },
  consumer_registration_kind_invalid: {
    userMessage: (context) =>
      `Consumer ${stringContextValue(context, 'id', 'this consumer')} registration kind is invalid.`,
    remediation: 'Internal error: invalid consumer registration kind. Report it with the code if persistent.',
  },
  equipment_slot_not_declared: {
    userMessage: (context) => `Equipment slot '${stringContextValue(context, 'slotId', 'unknown')}' is not declared.`,
    remediation: 'Declare the slot before reading or equipping it.',
  },
  slot_already_equipped: {
    userMessage: (context) =>
      `Slot '${stringContextValue(context, 'slotId', 'unknown')}' is equipped by '${stringContextValue(context, 'equippedBy', 'another tool')}'.`,
    remediation: (context) =>
      `Run 'coral-cli expansion unequip ${stringContextValue(context, 'equippedBy', 'that tool')}' first.`,
  },
  equipment_install_path_unwritable: {
    userMessage: (context) =>
      `Cannot write to the Coral equipment install path for ${stringContextValue(context, 'name', 'this equipment')}.`,
    remediation: 'Check filesystem permissions and free space under ~/.coral/data/equipment/, then retry.',
  },
} satisfies Record<DocumentedCoralSetupErrorCode, DocumentedCoralSetupErrorSpec>;

function renderDocumentedSpec(
  value: string | ((context?: CoralSetupErrorContext) => string),
  context?: CoralSetupErrorContext,
): string {
  return typeof value === 'function' ? value(context) : value;
}

export function documentedCoralSetupError(
  code: DocumentedCoralSetupErrorCode,
  context?: CoralSetupErrorContext,
  overrides: Partial<Pick<CoralSetupErrorInit, 'userMessage' | 'remediation'>> = {},
): CoralSetupError {
  const spec = DOCUMENTED_CORAL_SETUP_ERRORS[code];

  return new CoralSetupError({
    code,
    userMessage: overrides.userMessage ?? renderDocumentedSpec(spec.userMessage, context),
    remediation: overrides.remediation ?? renderDocumentedSpec(spec.remediation, context),
    ...(context === undefined ? {} : { context }),
  });
}

export class CoralSetupError extends Error {
  readonly code: string;
  readonly userMessage: string;
  readonly remediation: string;
  readonly context?: Record<string, unknown>;

  constructor(init: CoralSetupErrorInit) {
    super(init.userMessage);
    this.name = 'CoralSetupError';
    this.code = init.code;
    this.userMessage = init.userMessage;
    this.remediation = init.remediation;
    this.context = init.context;
    Object.setPrototypeOf(this, CoralSetupError.prototype);
  }
}

function isSerializedCoralSetupError(error: unknown): error is SerializedCoralSetupError {
  return (
    isRecord(error)
    && typeof error.code === 'string'
    && typeof error.userMessage === 'string'
    && typeof error.remediation === 'string'
  );
}

export function serializeCoralSetupError(error: unknown): SerializedCoralSetupError | null {
  if (error instanceof CoralSetupError) {
    return {
      code: error.code,
      userMessage: error.userMessage,
      remediation: error.remediation,
      ...(isRecord(error.context) ? { context: error.context } : {}),
    };
  }

  if (!isSerializedCoralSetupError(error)) {
    return null;
  }

  return {
    code: error.code,
    userMessage: error.userMessage,
    remediation: error.remediation,
    ...(isRecord(error.context) ? { context: error.context } : {}),
  };
}
