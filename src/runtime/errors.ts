export interface CoralSetupErrorInit {
  code: string;
  userMessage: string;
  remediation: string;
  context?: Record<string, unknown>;
}

export type CoralSetupErrorContext = Record<string, unknown>;

export type DocumentedCoralSetupErrorCode =
  | 'equipment_install_lock_contended'
  | 'equipment_binary_corrupt'
  | 'equipment_embedding_provider_missing'
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
      `Another /equip is in progress for ${stringContextValue(context, 'name', 'this equipment')}.`,
    remediation: 'Wait for the in-flight install to complete or remove the stale lock file.',
  },
  equipment_binary_corrupt: {
    userMessage: (context) =>
      `The installed binary for ${stringContextValue(context, 'name', 'this equipment')} could not be activated.`,
    remediation: (context) =>
      `Run '/equip ${stringContextValue(context, 'name', 'needle')}' again to reinstall the binary.`,
  },
  equipment_embedding_provider_missing: {
    userMessage: (context) =>
      `${stringContextValue(context, 'name', 'This equipment')} needs an embedding provider before it can be equipped.`,
    remediation:
      'Set CORAL_EMBEDDING_PROVIDER in ~/.coral/.env (and any required companion variables) before retrying /equip.',
  },
  equipment_slot_not_declared: {
    userMessage: (context) => `Equipment slot '${stringContextValue(context, 'slotId', 'unknown')}' is not declared.`,
    remediation: 'Declare the slot before reading or equipping it.',
  },
  slot_already_equipped: {
    userMessage: (context) =>
      `Slot '${stringContextValue(context, 'slotId', 'unknown')}' is equipped by '${stringContextValue(context, 'equippedBy', 'another tool')}'.`,
    remediation: (context) =>
      `Run '/equip uninstall ${stringContextValue(context, 'equippedBy', 'that tool')}' first.`,
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

export function documentedCoralSetupErrorSpec(code: DocumentedCoralSetupErrorCode): Readonly<{
  userMessage: string;
  remediation: string;
}> {
  return Object.freeze({
    userMessage: renderDocumentedSpec(DOCUMENTED_CORAL_SETUP_ERRORS[code].userMessage),
    remediation: renderDocumentedSpec(DOCUMENTED_CORAL_SETUP_ERRORS[code].remediation),
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
