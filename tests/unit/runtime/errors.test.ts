import { describe, it, expect } from 'vitest';
import {
  CoralSetupError,
  documentedCoralSetupError,
  documentedCoralSetupErrorExitCode,
  isRetryableCoralSetupError,
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
  it('owns documented exit and retryability policy in the setup-error registry', () => {
    const contended = documentedCoralSetupError('store_open_contended');

    expect(documentedCoralSetupErrorExitCode(contended.code)).toBe(75);
    expect(isRetryableCoralSetupError(contended)).toBe(true);
    expect(documentedCoralSetupErrorExitCode('store_open_unclassified')).toBe(70);
    expect(documentedCoralSetupErrorExitCode('kb_unavailable')).toBe(1);
    expect(isRetryableCoralSetupError(documentedCoralSetupError('store_open_unclassified'))).toBe(false);
    expect(documentedCoralSetupErrorExitCode('not_a_documented_code')).toBeUndefined();
    expect(isRetryableCoralSetupError(new Error('database is locked'))).toBe(false);
  });

  it('keeps an unclassified store cause in diagnostic context, not public text', () => {
    const error = documentedCoralSetupError('store_open_unclassified', {
      path: '/private/customer/store.db',
      cause: "EACCES: permission denied, open '/private/customer/store.db'",
    });

    expect(error.userMessage).toBe('Coral could not classify why the current-generation store could not be opened.');
    expect(error.userMessage).not.toContain('/private/customer');
    expect(error.remediation).toContain('error.context.cause');
    expect(error.context?.cause).toBe("EACCES: permission denied, open '/private/customer/store.db'");
  });

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
      'legacy_source_not_quiescent',
      { operation: 'store-reset', holder: 'install:kiwi (pid 42)', flavor: 'prod', baseDir: '/state' },
      'The generation-boundary operation cannot proceed while install:kiwi (pid 42) remains active.',
      "Run this build's own 'coral-cli backend shutdown'. Wait for 'install:kiwi (pid 42)' to exit and release its lease or lock, then retry 'coral-cli backend store-reset discard --target gen2 --flavor prod'.",
    ],
    [
      'legacy_source_not_quiescent',
      {
        operation: 'store-reset',
        holder: 'routing-status:handoff-routing-status (pid 42), process identity unobservable',
        writerObservation: 'unknown',
        flavor: 'prod',
      },
      'The generation-boundary operation cannot determine whether routing-status:handoff-routing-status (pid 42), process identity unobservable is still active.',
      "Restore process-identity and liveness observation for 'routing-status:handoff-routing-status (pid 42), process identity unobservable', then retry 'coral-cli backend store-reset discard --target gen2 --flavor prod'. If that writer has exited, its lease becomes reclaimable after ten minutes without a heartbeat; retry after that bound instead of deleting the lease.",
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
      "Run 'coral-cli backend shutdown' for the gen2 prod coordinator rooted at /state, then retry. The discard command never shuts down an incumbent daemon.",
    ],
    [
      'store_reset_interrupted_ambiguous',
      { flavor: 'prod' },
      'Coral found more than one interrupted backend store-reset publication and cannot determine which one to resume.',
      "Run 'coral-cli backend store-reset discard --target gen2 --flavor prod' to resume the interrupted reset under explicit operator control. Startup leaves the active store and staged incident unchanged.",
    ],
    [
      'store_reset_interrupted_foreign',
      { flavor: 'prod' },
      'Coral found an unrecognized entry in the interrupted backend store-reset staging area.',
      "Run 'coral-cli backend store-reset discard --target gen2 --flavor prod' to resume the interrupted reset under explicit operator control. Startup leaves the active store and staged incident unchanged.",
    ],
    [
      'store_reset_interrupted_mismatched',
      { flavor: 'prod' },
      'Coral found interrupted backend store-reset evidence whose manifest identity does not match its staged publication.',
      "Run 'coral-cli backend store-reset discard --target gen2 --flavor prod' to resume the interrupted reset under explicit operator control. Startup leaves the active store and staged incident unchanged.",
    ],
    [
      'store_reset_interrupted_authority_mismatch',
      { flavor: 'prod' },
      'Coral found an interrupted backend store-reset incident authored for a different build, store, or flavor.',
      "Run 'coral-cli backend store-reset discard --target gen2 --flavor prod' to resume the interrupted reset under explicit operator control. Startup leaves the active store and staged incident unchanged.",
    ],
    [
      'store_reset_interrupted_malformed',
      { flavor: 'prod' },
      'Coral found a malformed interrupted backend store-reset incident.',
      "Run 'coral-cli backend store-reset discard --target gen2 --flavor prod' to resume the interrupted reset under explicit operator control. Startup leaves the active store and staged incident unchanged.",
    ],
    [
      'store_reset_interrupted_non_resettable',
      { flavor: 'prod' },
      'Coral found an interrupted legacy V2 backend store-reset incident that cannot be resumed automatically.',
      "Run 'coral-cli backend store-reset discard --target gen2 --flavor prod' to resume the interrupted reset under explicit operator control. Startup leaves the active store and staged incident unchanged.",
    ],
    [
      'store_reset_quarantine_failed',
      { reason: 'classified_evidence_missing', flavor: 'prod' },
      'Coral found no active backend store files to quarantine after classifying the store for reset.',
      "Retry startup once. If the store is classified for reset again without any active files, run 'coral-cli backend status' and report this code. Do not create, move, delete, restore, or upload DB, WAL, or SHM evidence.",
    ],
    [
      'recovery_quarantine_boundary_not_registered',
      {},
      'That recovery boundary is not available for operator retry.',
      'Run `coral-cli backend recovery-quarantine list` and copy the boundary from a retained row. If the listed boundary is still rejected, update Coral and retry.',
    ],
    [
      'recovery_quarantine_revision_changed',
      {},
      'That recovery quarantine coordinate is stale because its revision changed.',
      'Run `coral-cli backend recovery-quarantine list`, copy the row’s current boundary, key, and revision, then retry clear with that exact coordinate.',
    ],
    [
      'recovery_quarantine_continuation_pending',
      {},
      'That recovery quarantine row is a durable continuation and cannot be cleared directly.',
      'Run `coral-cli backend recovery-quarantine list` to inspect the continuation. Leave it retained for the owning recovery flow; do not repeat clear with the same coordinate.',
    ],
    [
      'recovery_quarantine_retry_in_progress',
      {},
      'A recovery retry is already in progress for that quarantine row.',
      'Wait for the coordinator to finish the retry, then run `coral-cli backend recovery-quarantine list`. Retry clear only if the row returns to the active state.',
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

  describe('the relocated socket directory refusals', () => {
    it('separates an ownership verdict from an observation that was never made', () => {
      const foreign = documentedCoralSetupError({
        code: 'coordinator_socket_dir_insecure',
        reason: 'foreign',
        directory: '/tmp/coral-1000',
      });
      const unusable = documentedCoralSetupError({
        code: 'coordinator_socket_dir_insecure',
        reason: 'unusable',
        directory: '/tmp/coral-1000',
      });
      const unsecurable = documentedCoralSetupError({
        code: 'coordinator_socket_dir_insecure',
        reason: 'unsecurable',
        directory: '/tmp/coral-1000',
        cause: "its parent '/tmp' is writable by other users and does not restrict deletion",
      });
      const unverified = documentedCoralSetupError({
        code: 'coordinator_socket_dir_unverified',
        directory: '/tmp/coral-1000',
        cause: "EACCES: permission denied, lstat '/tmp/coral-1000'",
      });
      const parentUnverified = documentedCoralSetupError({
        code: 'coordinator_socket_dir_unverified',
        directory: '/tmp/coral-1000',
        cause: "EACCES: permission denied, stat '/tmp'",
      });
      const invalidUid = documentedCoralSetupError({
        code: 'coordinator_socket_dir_unverified',
        directory: '/tmp/coral-NaN',
        cause: 'the owner uid named by the socket address is not usable',
      });
      const missingOwner = documentedCoralSetupError({
        code: 'coordinator_socket_dir_unverified',
        directory: '/tmp/coral-1000',
        cause: 'the directory reported no owner',
      });

      for (const error of [foreign, unusable, unsecurable]) {
        expect(error.userMessage).toContain('/tmp/coral-1000');
        expect(`${error.userMessage} ${error.remediation}`).not.toContain('<directory>');
        expect(`${error.userMessage} ${error.remediation}`).not.toContain('cause unavailable');
      }
      for (const error of [foreign, unusable]) {
        expect(error.remediation).toContain('/tmp/coral-1000');
      }
      expect(foreign.userMessage).toContain('belongs to another user');
      expect(foreign.remediation).not.toMatch(/^Remove/u);
      expect(unusable.userMessage).toBe(
        "Coral's coordinator socket uses /tmp/coral-1000 as its fallback directory, and that path is not a directory.",
      );
      expect(unusable.remediation).toContain('Remove');
      expect(unsecurable.remediation).not.toContain('Remove');
      expect(unsecurable.userMessage).toBe(
        "Coral's coordinator socket uses /tmp/coral-1000 as its fallback directory, and Coral cannot keep that path private to you (its parent '/tmp' is writable by other users and does not restrict deletion).",
      );
      expect(unsecurable.remediation).toBe(
        "Give this host's administrator the observation above. Coral did not bind its singleton socket. Start Coral again once the directory is repaired.",
      );
      expect(unverified.userMessage).toBe(
        "Coral's coordinator socket uses a fallback directory, but Coral could not establish whether it is private to you (EACCES: permission denied, lstat '/tmp/coral-1000'). This does not mean the directory is wrong.",
      );
      expect(parentUnverified.userMessage).toBe(
        "Coral's coordinator socket uses /tmp/coral-1000, but Coral could not establish whether that directory is private to you (EACCES: permission denied, stat '/tmp'). This does not mean the directory is wrong.",
      );
      for (const error of [unverified, parentUnverified]) {
        expect(error.remediation).toBe(
          'Resolve the filesystem error reported in the observation above, then start Coral again. Coral will not bind its singleton socket in a directory it could not observe.',
        );
      }
      expect(invalidUid.remediation).toBe(
        'Start Coral in an environment that provides an owner uid the filesystem can represent for the fallback socket address. Coral will not bind its singleton socket without a usable owner identity.',
      );
      expect(missingOwner.remediation).toBe(
        'Start Coral on a filesystem that reports owner identity for the fallback directory. The observation succeeded but did not identify an owner, so Coral could not settle whether the directory is private.',
      );
      expect(missingOwner.remediation).not.toContain('error');
    });
  });
});
