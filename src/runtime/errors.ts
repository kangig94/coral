// Canonical setup-error registry. Holds the cross-cutting CoralSetupError
// class together with its documented code catalog. An error code catalog is
// a *registry of typed identifiers* — a single canonical home is the right
// shape (analogous to HTTP status codes, POSIX errno, SQLSTATE). The "magnet"
// anti-pattern only applies to files that absorb unrelated *logic*
// (helpers.ts, utils.ts); a registry growing as new codes land is the
// expected shape of a canonical home, not drift.
//
// Abort vocabulary lives at `src/runtime/abort.ts`; re-exported here so
// runtime-error callers see one location.

import { isRecord } from '../infra/json.js';

export { AbortError, isAbortError, throwIfAborted } from './abort.js';

export interface CoralSetupErrorInit {
  code: string;
  userMessage: string;
  remediation: string;
  context?: Record<string, unknown>;
}

export type CoralSetupErrorContext = Record<string, unknown>;
export type SerializedCoralSetupError = CoralSetupErrorInit;

export type DocumentedCoralSetupErrorCode =
  | 'expansion_install_lock_contended'
  | 'expansion_binary_corrupt'
  | 'installer_payload_invalid'
  | 'unknown_expansion'
  | 'expansion_bundled_immutable'
  | 'expansion_runtime_unavailable'
  | 'expansion_equip_aborted'
  | 'engine_env_var_missing'
  | 'expansion_embedding_provider_missing'
  | 'expansion_not_equipped'
  | 'consumer_not_registered'
  | 'consumer_authority_mismatch'
  | 'consumer_interest_mismatch'
  | 'consumer_registration_kind_mismatch'
  | 'consumer_lane_invalid'
  | 'consumer_wait_unsupported'
  | 'consumer_unregister_requires_stop'
  | 'consumer_interest_invalid'
  | 'consumer_registration_kind_invalid'
  | 'expansion_install_path_unwritable'
  | 'binding_empty'
  | 'kb_unavailable'
  | 'binding_occupied'
  | 'binding_required'
  | 'binding_required_by_active_engine'
  | 'user_cancelled';

type DocumentedCoralSetupErrorSpec = {
  readonly userMessage: string | ((context?: CoralSetupErrorContext) => string);
  readonly remediation: string | ((context?: CoralSetupErrorContext) => string);
};

function stringContextValue(context: CoralSetupErrorContext | undefined, key: string, fallback: string): string {
  const raw = context?.[key];
  return typeof raw === 'string' && raw.trim().length > 0 ? raw : fallback;
}

const DOCUMENTED_CORAL_SETUP_ERRORS = {
  expansion_install_lock_contended: {
    userMessage: (context) =>
      `Another coral-cli expansion equip is in progress for ${stringContextValue(context, 'name', 'this expansion')}.`,
    remediation: 'Wait for the in-flight install to complete or remove the stale lock file.',
  },
  expansion_binary_corrupt: {
    userMessage: (context) =>
      `The installed binary for ${stringContextValue(context, 'name', 'this expansion')} could not be activated.`,
    remediation: (context) =>
      `Run 'coral-cli expansion unequip ${stringContextValue(context, 'name', '<name>')}' before retrying 'coral-cli expansion equip ${stringContextValue(context, 'name', '<name>')}'.`,
  },
  installer_payload_invalid: {
    userMessage: 'Expansion installer returned an invalid payload.',
    remediation:
      'Retry the command. If this persists, report the code because the installer response failed internal validation.',
  },
  unknown_expansion: {
    userMessage: (context) =>
      `The expansion ${stringContextValue(context, 'name', 'this expansion')} is not registered in the Coral catalog.`,
    remediation: "Run 'coral-cli expansion list' to see available expansions.",
  },
  expansion_bundled_immutable: {
    userMessage: (context) =>
      `Bundled engine '${stringContextValue(context, 'name', 'this engine')}' cannot be equipped or unequipped (it auto-equips at boot).`,
    remediation:
      "Bundled engines are managed by the coordinator's fallback pass. Use 'coral-cli expansion list' to view their status.",
  },
  expansion_runtime_unavailable: {
    userMessage: (context) =>
      `Expansion runtime is not available for ${stringContextValue(context, 'name', 'this expansion')}.`,
    remediation: (context) =>
      `Restart Coral or run 'coral-cli expansion equip ${stringContextValue(context, 'name', '<name>')}' to retry.`,
  },
  expansion_equip_aborted: {
    userMessage: (context) =>
      `Equipping '${stringContextValue(context, 'name', 'this expansion')}' was aborted because the coordinator is shutting down.`,
    remediation: (context) =>
      `Wait for the new coordinator to finish booting, then run 'coral-cli expansion equip ${stringContextValue(context, 'name', '<name>')}' again.`,
  },
  engine_env_var_missing: {
    userMessage: (context) =>
      `Engine '${stringContextValue(context, 'engine', 'this engine')}' needs environment variable '${stringContextValue(context, 'envVar', '<UNSET>')}'.`,
    remediation: (context) =>
      `Set ${stringContextValue(context, 'envVar', '<ENV>')} (e.g. add it to ~/.coral/.env) and rerun \`coral-cli expansion equip ${stringContextValue(context, 'engine', '<engine>')}\`.`,
  },
  expansion_embedding_provider_missing: {
    userMessage: (context) =>
      `${stringContextValue(context, 'name', 'This expansion')} needs an embedding expansion before it can be equipped.`,
    remediation: (context) =>
      `Equip an embedding expansion before retrying 'coral-cli expansion equip ${stringContextValue(context, 'name', '<name>')}'.`,
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
    userMessage: (context) => `Consumer ${stringContextValue(context, 'id', 'this consumer')} interest mismatch.`,
    remediation: 'Verify consumer interest declaration matches the registration.',
  },
  consumer_registration_kind_mismatch: {
    userMessage: (context) =>
      `Consumer ${stringContextValue(context, 'id', 'this consumer')} registration kind mismatch: expected ${stringContextValue(context, 'expected', 'unknown')}, got ${stringContextValue(context, 'actual', 'unknown')}.`,
    remediation: 'Check that registration kind (base vs expansion) is consistent.',
  },
  consumer_lane_invalid: {
    userMessage: (context) => `Consumer ${stringContextValue(context, 'id', 'this consumer')} lane is invalid.`,
    remediation: 'Verify lane configuration against registration.',
  },
  consumer_wait_unsupported: {
    userMessage: (context) => `Consumer ${stringContextValue(context, 'id', 'this consumer')} does not support wait.`,
    remediation: 'Consumer does not support fresh-wait; use status polling.',
  },
  consumer_unregister_requires_stop: {
    userMessage: (context) =>
      `Consumer ${stringContextValue(context, 'id', 'this consumer')} must be stopped before unregister.`,
    remediation:
      'Consumer must be stopped before unregister; this is an internal sequencing error. Report it with the code if persistent.',
  },
  consumer_interest_invalid: {
    userMessage: (context) => `Consumer ${stringContextValue(context, 'id', 'this consumer')} interest is invalid.`,
    remediation: 'Verify consumer interest declaration structure.',
  },
  consumer_registration_kind_invalid: {
    userMessage: (context) =>
      `Consumer ${stringContextValue(context, 'id', 'this consumer')} registration kind is invalid.`,
    remediation: 'Internal error: invalid consumer registration kind. Report it with the code if persistent.',
  },
  expansion_install_path_unwritable: {
    userMessage: (context) =>
      `Cannot write to the Coral expansion install path for ${stringContextValue(context, 'name', 'this expansion')}.`,
    remediation: 'Check filesystem permissions and free space under ~/.coral/data/engines/, then retry.',
  },
  expansion_not_equipped: {
    userMessage: (context) => `Expansion '${stringContextValue(context, 'name', 'this expansion')}' is not equipped.`,
    remediation: "Check 'coral-cli expansion list' before unequipping.",
  },
  binding_empty: {
    userMessage: (context) => `Binding '${stringContextValue(context, 'binding', 'unknown')}' is empty.`,
    remediation: 'Bind the required runtime capability before reading it.',
  },
  kb_unavailable: {
    userMessage: (context) =>
      `Knowledge base is not available for readiness '${stringContextValue(context, 'readiness', 'unknown')}'.`,
    remediation: (context) => {
      const binding = stringContextValue(context, 'binding', '<binding>');
      return `No engine is currently bound to '${binding}'. Equip the bundled or installed engine that fills it, then retry.`;
    },
  },
  binding_occupied: {
    userMessage: (context) =>
      `Binding '${stringContextValue(context, 'binding', 'unknown')}' is held by '${stringContextValue(context, 'heldBy', 'another expansion')}'.`,
    remediation: (context) => {
      const heldBy = stringContextValue(context, 'heldBy', '<holder>');
      return `Run '/equip uninstall ${heldBy}' (or 'coral-cli expansion unequip ${heldBy}') to release the binding, then retry.`;
    },
  },
  binding_required: {
    userMessage: (context) =>
      `Binding '${stringContextValue(context, 'binding', 'unknown')}' is required by '${stringContextValue(context, 'requiredBy', 'this expansion')}'.`,
    remediation: (context) =>
      `Bind '${stringContextValue(context, 'binding', 'unknown')}' before loading '${stringContextValue(context, 'requiredBy', 'this expansion')}'.`,
  },
  binding_required_by_active_engine: {
    userMessage: (context) =>
      `Binding '${stringContextValue(context, 'binding', 'unknown')}' is required by active engine '${stringContextValue(context, 'requiredBy', 'this expansion')}'.`,
    remediation: (context) =>
      `Unequip '${stringContextValue(context, 'requiredBy', 'this expansion')}' before unequipping the engine that fills '${stringContextValue(context, 'binding', 'unknown')}'.`,
  },
  user_cancelled: {
    userMessage: (context) => `User cancelled '${stringContextValue(context, 'during', 'the operation')}'.`,
    remediation: (context) => {
      const alreadyEquipped = context?.alreadyEquipped;
      if (typeof alreadyEquipped === 'string' && alreadyEquipped.length > 0) {
        return `An embedder ('${alreadyEquipped}') is already configured. Run the requested equip command again to continue, or '/equip uninstall ${alreadyEquipped}' to clean up.`;
      }
      return 'Retry the operation when ready.';
    },
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
    isRecord(error) &&
    typeof error.code === 'string' &&
    typeof error.userMessage === 'string' &&
    typeof error.remediation === 'string'
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
