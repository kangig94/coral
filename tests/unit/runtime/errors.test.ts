import { describe, it, expect } from 'vitest';
import {
  CoralSetupError,
  documentedCoralSetupError,
  type DocumentedCoralSetupErrorCode,
} from '#src/runtime/errors.js';

function documentedCoralSetupErrorSpec(code: DocumentedCoralSetupErrorCode): Readonly<{
  userMessage: string;
  remediation: string;
}> {
  const error = documentedCoralSetupError(code);
  return Object.freeze({
    userMessage: error.userMessage,
    remediation: error.remediation,
  });
}

describe('CoralSetupError', () => {
  it('should construct with all fields', () => {
    const err = new CoralSetupError({
      code: 'E_TEST',
      userMessage: 'user-facing message',
      remediation: 'do this',
      context: { foo: 'bar' },
    });
    expect(err.code).toBe('E_TEST');
    expect(err.userMessage).toBe('user-facing message');
    expect(err.remediation).toBe('do this');
    expect(err.context).toEqual({ foo: 'bar' });
  });

  it('should set .name to "CoralSetupError"', () => {
    const err = new CoralSetupError({ code: 'E', userMessage: 'u', remediation: 'r' });
    expect(err.name).toBe('CoralSetupError');
  });

  it('should satisfy instanceof CoralSetupError and Error', () => {
    const err = new CoralSetupError({ code: 'E', userMessage: 'u', remediation: 'r' });
    expect(err instanceof CoralSetupError).toBe(true);
    expect(err instanceof Error).toBe(true);
  });

  it('should accept undefined context', () => {
    const err = new CoralSetupError({ code: 'E', userMessage: 'u', remediation: 'r' });
    expect(err.context).toBeUndefined();
  });

  it.each([
    [
      'equipment_install_lock_contended',
      { name: 'needle' },
      'Another coral-cli expansion equip is in progress for needle.',
      'Wait for the in-flight install to complete or remove the stale lock file.',
    ],
    [
      'equipment_binary_corrupt',
      { name: 'needle' },
      'The installed binary for needle could not be activated.',
      "Run 'coral-cli expansion unequip needle' before retrying 'coral-cli expansion equip needle'.",
    ],
    [
      'installer_payload_invalid',
      {},
      'Expansion installer returned an invalid payload.',
      'Retry the command. If this persists, report the code because the installer response failed internal validation.',
    ],
    [
      'unknown_equipment',
      { name: 'needle' },
      'The equipment needle is not registered in the Coral catalog.',
      "Run 'coral-cli expansion list' to see available equipment.",
    ],
    [
      'equipment_runtime_unavailable',
      { name: 'needle' },
      'Equipment runtime is not available for needle.',
      "Restart Coral or run 'coral-cli expansion equip needle' to retry.",
    ],
    [
      'equipment_embedding_provider_missing',
      { name: 'Needle' },
      'Needle needs an embedding provider before it can be equipped.',
      "Set CORAL_EMBEDDING_PROVIDER in ~/.coral/.env (and any required companion variables) before retrying 'coral-cli expansion equip Needle'.",
    ],
    [
      'consumer_not_registered',
      { id: 'consumer-a' },
      'Consumer consumer-a is not registered with the coordinator.',
      'Re-equip or verify the consumer registration.',
    ],
    [
      'consumer_authority_mismatch',
      { id: 'consumer-a', expected: 'journal', actual: 'corpus' },
      'Consumer consumer-a authority mismatch: expected journal, got corpus.',
      'Verify consumer registration ordering and authority.',
    ],
    [
      'consumer_interest_mismatch',
      { id: 'consumer-a' },
      'Consumer consumer-a interest mismatch.',
      'Verify consumer interest declaration matches the registration.',
    ],
    [
      'consumer_registration_kind_mismatch',
      { id: 'consumer-a', expected: 'base', actual: 'equipment' },
      'Consumer consumer-a registration kind mismatch: expected base, got equipment.',
      'Check that registration kind (base vs equipment) is consistent.',
    ],
    [
      'consumer_lane_invalid',
      { id: 'consumer-a' },
      'Consumer consumer-a lane is invalid.',
      'Verify lane configuration against registration.',
    ],
    [
      'consumer_wait_unsupported',
      { id: 'consumer-a' },
      'Consumer consumer-a does not support wait.',
      'Consumer does not support fresh-wait; use status polling.',
    ],
    [
      'consumer_unregister_requires_stop',
      { id: 'consumer-a' },
      'Consumer consumer-a must be stopped before unregister.',
      'Consumer must be stopped before unregister; this is an internal sequencing error. Report it with the code if persistent.',
    ],
    [
      'consumer_interest_invalid',
      { id: 'consumer-a' },
      'Consumer consumer-a interest is invalid.',
      'Verify consumer interest declaration structure.',
    ],
    [
      'consumer_registration_kind_invalid',
      { id: 'consumer-a' },
      'Consumer consumer-a registration kind is invalid.',
      'Internal error: invalid consumer registration kind. Report it with the code if persistent.',
    ],
    [
      'equipment_slot_not_declared',
      { slotId: 'kb.vector' },
      "Equipment slot 'kb.vector' is not declared.",
      'Declare the slot before reading or equipping it.',
    ],
    [
      'slot_already_equipped',
      { slotId: 'kb.vector', equippedBy: 'needle' },
      "Slot 'kb.vector' is equipped by 'needle'.",
      "Run 'coral-cli expansion unequip needle' first.",
    ],
    [
      'equipment_install_path_unwritable',
      { name: 'needle' },
      'Cannot write to the Coral equipment install path for needle.',
      'Check filesystem permissions and free space under ~/.coral/data/equipment/, then retry.',
    ],
  ] satisfies Array<[DocumentedCoralSetupErrorCode, Record<string, unknown>, string, string]>)(
    'renders documented setup error %s through CoralSetupError',
    (code, context, userMessage, remediation) => {
      const err = documentedCoralSetupError(code, context);

      expect(err).toBeInstanceOf(CoralSetupError);
      expect(err.code).toBe(code);
      expect(err.message).toBe(userMessage);
      expect(err.userMessage).toBe(userMessage);
      expect(err.remediation).toBe(remediation);
      expect(err.context).toEqual(context);
    },
  );

  it('exposes stable documented specs for known setup codes', () => {
    expect(documentedCoralSetupErrorSpec('equipment_binary_corrupt')).toEqual({
      userMessage: 'The installed binary for this equipment could not be activated.',
      remediation:
        "Run 'coral-cli expansion unequip needle' before retrying 'coral-cli expansion equip needle'.",
    });
  });
});
