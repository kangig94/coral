import { describe, it, expect } from 'vitest';
import {
  CoralSetupError,
  documentedCoralSetupError,
  documentedCoralSetupErrorSpec,
  type DocumentedCoralSetupErrorCode,
} from '../errors.js';

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
      'Another /equip is in progress for needle.',
      'Wait for the in-flight install to complete or remove the stale lock file.',
    ],
    [
      'equipment_binary_corrupt',
      { name: 'needle' },
      'The installed binary for needle could not be activated.',
      "Run '/equip needle' again to reinstall the binary.",
    ],
    [
      'equipment_embedding_provider_missing',
      { name: 'Needle' },
      'Needle needs an embedding provider before it can be equipped.',
      'Set CORAL_EMBEDDING_PROVIDER in ~/.coral/.env (and any required companion variables) before retrying /equip.',
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
      "Run '/equip uninstall needle' first.",
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
      remediation: "Run '/equip needle' again to reinstall the binary.",
    });
  });
});
