import { describe, it, expect } from 'vitest';
import { CoralSetupError, documentedCoralSetupError, type DocumentedCoralSetupErrorCode } from '#src/runtime/errors.js';

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
      'expansion_install_lock_contended',
      { name: 'vector' },
      'Another package operation is in progress for vector.',
      'Wait for the in-flight operation to complete, then retry. If this persists after ten minutes with no Coral process running, report the JSON error code and context; do not delete a live lock.',
    ],
    [
      'expansion_install_artifact_failed',
      { name: 'kiwi', detail: 'archive digest mismatch' },
      'Coral could not install the runtime artifacts for kiwi.',
      "archive digest mismatch\nCheck network access, filesystem permissions, and free space, then retry 'coral-cli expansion equip kiwi'.",
    ],
    [
      'store_schema_outdated',
      { version: '0.9.16', flavor: 'prod' },
      'Coral backend store format does not match this installation.',
      "This build cannot read this store's format. Use Coral 0.9.16 to read this store, or deliberately destroy its history by running 'coral-cli backend store-reset discard --target gen2 --flavor prod'; this build can then initialize an empty store.",
    ],
    [
      'store_schema_outdated',
      { flavor: 'dev' },
      'Coral backend store format does not match this installation.',
      "This build cannot read this store's format. To deliberately destroy its history, run 'coral-cli backend store-reset discard --target gen2 --flavor dev'; this build can then initialize an empty store.",
    ],
    [
      'legacy_foreign_generation',
      {
        operation: 'discard',
        legacyPath: '/state/data',
        version: null,
        flavor: 'prod',
        baseDir: '/state',
      },
      'Coral cannot safely discard the foreign-generation tree at /state/data.',
      'Close every older-version session that may use /state/data; stored Coral version: unknown. Then remove that tree yourself. This command refused without changing it. Active baseDir: /state.',
    ],
    [
      'legacy_adoption_required',
      { legacyPath: '/state/data', flavor: 'prod' },
      'Compatible legacy Coral history at /state/data must be adopted before this generation can initialize.',
      "Run 'coral-cli backend store-adopt --flavor prod', then retry the command that starts the backend.",
    ],
    [
      'legacy_source_not_quiescent',
      { operation: 'store-reset', holder: 'install:kiwi (pid 42)', flavor: 'prod', baseDir: '/state' },
      'The current-generation adoption source still has an active writer lease held by install:kiwi (pid 42).',
      "Run this build's own 'coral-cli backend shutdown'. Wait for current-generation writer-lease holder 'install:kiwi (pid 42)' to exit and release its lease, then retry 'coral-cli backend store-reset discard --target gen2 --flavor prod'.",
    ],
    [
      'store_reset_lock_contended',
      {
        holder: 'gen2 coordinator socket',
        socketPath: '/state/gen2/run/coordinator.sock',
        target: 'gen2',
        flavor: 'prod',
        baseDir: '/state',
      },
      'Store reset refused because the gen2 coordinator socket is already owned.',
      'Stop the gen2 prod coordinator rooted at /state, then retry. The discard command never shuts down an incumbent daemon.',
    ],
    [
      'expansion_binary_corrupt',
      { name: 'vector' },
      'The installed binary for vector could not be activated.',
      "Run 'coral-cli expansion unequip vector' before retrying 'coral-cli expansion equip vector'.",
    ],
    [
      'installer_payload_invalid',
      {},
      'Expansion installer returned an invalid payload.',
      'Retry the command. If this persists, report the code because the installer response failed internal validation.',
    ],
    [
      'unknown_expansion',
      { name: 'vector' },
      'The expansion vector is not registered in the Coral catalog.',
      "Run 'coral-cli expansion list' to see available expansions.",
    ],
    [
      'expansion_bundled_immutable',
      { name: 'orama' },
      "Bundled engine 'orama' cannot be equipped or unequipped (it auto-equips at boot).",
      "Bundled engines are managed by the coordinator's fallback pass. Use 'coral-cli expansion list' to view their status.",
    ],
    [
      'expansion_runtime_unavailable',
      { name: 'vector' },
      'Expansion runtime is not available for vector.',
      "Restart Coral or run 'coral-cli expansion equip vector' to retry.",
    ],
    [
      'engine_env_var_missing',
      { engine: 'gemini', envVar: 'GEMINI_API_KEY' },
      "Engine 'gemini' needs environment variable 'GEMINI_API_KEY'.",
      "Set GEMINI_API_KEY in the backend's environment (e.g. the `env` block of ~/.claude/settings.json), run 'coral-cli backend shutdown' so the next command relaunches with it, then rerun `coral-cli expansion equip gemini`.",
    ],
    [
      'expansion_embedding_provider_missing',
      { name: 'Vector' },
      'Vector needs an embedding expansion before it can be equipped.',
      "Equip an embedding expansion before retrying 'coral-cli expansion equip Vector'.",
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
      { id: 'consumer-a', expected: 'base', actual: 'expansion' },
      'Consumer consumer-a registration kind mismatch: expected base, got expansion.',
      'Check that registration kind (base vs expansion) is consistent.',
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
      'expansion_install_path_unwritable',
      { name: 'vector' },
      'Cannot write to the Coral expansion install path for vector.',
      'Check filesystem permissions and free space under ~/.coral/data/engines/, then retry.',
    ],
    [
      'capability_required_by_active_engine',
      {
        target: 'gemini',
        capabilities: [
          {
            capability: 'kb.embedding',
            dependents: [{ expansion: 'vector', edgeKind: 'read', source: 'onboarding', state: 'active' }],
          },
        ],
      },
      "Capability removal for 'gemini' is blocked by an active engine dependency.",
      'Unequip active dependent engines before removing the capability provider.',
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
    expect(documentedCoralSetupErrorSpec('expansion_binary_corrupt')).toEqual({
      userMessage: 'The installed binary for this expansion could not be activated.',
      remediation: "Run 'coral-cli expansion unequip <name>' before retrying 'coral-cli expansion equip <name>'.",
    });
  });
});
