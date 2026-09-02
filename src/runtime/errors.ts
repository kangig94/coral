// Canonical setup-error registry. Holds the cross-cutting CoralSetupError
// class together with its documented code catalog. An error code catalog is
// a *registry of typed identifiers* — a single canonical home is the right
// shape (analogous to HTTP status codes, POSIX errno, SQLSTATE). The "magnet"
// anti-pattern only applies to files that absorb unrelated *logic*
// (helpers.ts, utils.ts); a registry growing as new codes land is the
// expected shape of a canonical home, not drift.

import { isAbsolute, normalize } from 'node:path';

import { isRecord } from '../infra/json.js';
import { HANDOFF_SIGNAL_POLICY_ENV } from '../infra/process-constants.js';

export interface CoralSetupErrorInit {
  code: string;
  userMessage: string;
  remediation: string;
  context?: Record<string, unknown>;
}

export type CoralSetupErrorContext = Record<string, unknown>;
export type SerializedCoralSetupError = CoralSetupErrorInit;

export type OperatorFacingCoralSetupError =
  | Readonly<{
      kind: 'documented';
      code: DocumentedCoralSetupErrorCode;
      userMessage: string;
      remediation: string;
    }>
  | Readonly<{
      kind: 'self_authored';
      code: string;
      userMessage: string;
      remediation: string;
    }>
  | Readonly<{ kind: 'unrecognized_code'; code: string; authorship: SetupErrorAuthorshipKind }>
  | Readonly<{ kind: 'invalid_diagnostic' }>;

/**
 * Which build authored a persisted setup-error record. `unprovable` is not a weaker `other-build`: it is the
 * answer when either side's identity is missing or not an identifier, and an identity that cannot be proven
 * may not stand for equality — two builds that both fail to prove one would otherwise compare equal.
 */
export type SetupErrorAuthorshipKind = 'this-build' | 'other-build' | 'unprovable';

export type SetupErrorAuthorIdentity = Readonly<{ bundleHash: string; namespace: string }>;

const setupErrorAuthorshipProof: unique symbol = Symbol('SetupErrorAuthorshipProof');

/** Only `resolveSetupErrorAuthorship` may mint this; a caller cannot assert `this-build` without the identities. */
export type SetupErrorAuthorship = Readonly<{
  kind: SetupErrorAuthorshipKind;
  [setupErrorAuthorshipProof]: true;
}>;

export type DocumentedCoralSetupErrorCode =
  | 'expansion_install_lock_contended'
  | 'expansion_install_command_failed'
  | 'expansion_install_artifact_failed'
  | 'startup_not_ready'
  | 'startup_bundle_unresolvable'
  | 'system_provider_scope_invalid'
  | 'coordinator_socket_in_use'
  | 'coordinator_socket_bind_failed'
  | 'coordinator_socket_dir_insecure'
  | 'coordinator_socket_dir_unverified'
  | 'store_schema_outdated'
  | 'legacy_foreign_generation'
  | 'legacy_source_not_quiescent'
  | 'legacy_source_writer_observation_unknown'
  | 'active_store_coordination_invalid'
  | 'store_newer_incompatible'
  | 'store_older_incompatible'
  | 'store_corrupt_or_unsupported'
  | 'store_open_contended'
  | 'store_open_unclassified'
  | 'store_not_initialized'
  | 'kb_commit_corrupt_or_unsupported'
  | 'kb_commit_id_invalid'
  | 'kb_commit_not_found'
  | 'kb_commit_already_quarantined'
  | 'kb_commit_quarantine_failed'
  | 'store_reset_lock_contended'
  | 'store_reset_interrupted_ambiguous'
  | 'store_reset_interrupted_foreign'
  | 'store_reset_interrupted_mismatched'
  | 'store_reset_interrupted_authority_mismatch'
  | 'store_reset_interrupted_malformed'
  | 'store_reset_interrupted_non_resettable'
  | 'store_reset_quarantine_failed'
  | 'recovery_quarantine_boundary_not_registered'
  | 'recovery_quarantine_subject_not_found'
  | 'recovery_quarantine_revision_changed'
  | 'recovery_quarantine_continuation_pending'
  | 'recovery_quarantine_retry_in_progress'
  | 'expansion_binary_corrupt'
  | 'installer_payload_invalid'
  | 'coordinator_record_unreadable'
  | 'coordinator_unreachable'
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
  | 'consumer_wait_fresh_invalid_target'
  | 'expansion_install_path_unwritable'
  | 'retired_expansion_id_invalid'
  | 'retired_expansion_cleanup_required'
  | 'retired_expansion_consumer_active'
  | 'retired_expansion_cleanup_in_progress'
  | 'retired_expansion_cursor_unsafe'
  | 'retired_expansion_cursor_changed'
  | 'binding_empty'
  | 'kb_unavailable'
  | 'kb_initializing'
  | 'kb_offline'
  | 'binding_occupied'
  | 'binding_required'
  | 'capability_name_occupied'
  | 'capability_namespace_reserved'
  | 'capability_fill_unknown'
  | 'capability_fill_undeclared'
  | 'capability_require_undeclared'
  | 'capability_descriptor_mismatch'
  | 'capability_descriptor_unregistered'
  | 'capability_required_by_active_engine'
  | 'capability_catalog_remove_blocked'
  | 'require_binding_unknown'
  | 'role_id_occupied'
  | 'role_descriptor_mismatch'
  | 'role_descriptor_unregistered'
  | 'handoff_fresh_discovery_unavailable'
  | 'handoff_fresh_discovery_changed'
  | 'handoff_signal_capability_unavailable'
  | 'handoff_signal_cooldown_active'
  | 'handoff_legacy_signal_attempt_indeterminate'
  | 'handoff_shutdown_capability_rejected'
  | 'handoff_shutdown_credential_unavailable'
  | 'handoff_socket_holder_unverified'
  | 'handoff_manual_policy'
  | 'handoff_term_only_policy'
  | 'handoff_process_identity_unavailable'
  | 'handoff_process_liveness_unknown'
  | 'handoff_platform_identity_insufficient'
  | 'handoff_published_incarnation_missing'
  | 'handoff_published_incarnation_mismatch'
  | 'handoff_signal_anchor_missing'
  | 'handoff_pid_recycled'
  | 'handoff_signal_rejected_live'
  | 'handoff_accepted_signal_target_alive_after_failure'
  | 'handoff_accepted_signal_target_alive_after_bind'
  | 'handoff_sigkill_grace_target_gone_socket_still_bound'
  | 'handoff_sigkill_grace_target_alive'
  | 'user_cancelled';

export type HandoffRefusalCode = Extract<DocumentedCoralSetupErrorCode, `handoff_${string}`>;

export type MissingSignalCapabilityField = 'instanceId' | 'token' | 'bootToken';

export type HandoffVerificationContext =
  | { readonly stage: 'before-signal'; readonly pid: number }
  | {
      readonly stage: 'after-rejected-signal';
      readonly pid: number;
      readonly signal: 'SIGTERM' | 'SIGKILL';
    }
  | {
      readonly stage: 'after-accepted-signal-bind';
      readonly pid: number;
      readonly signal: 'SIGTERM' | 'SIGKILL';
    }
  | {
      readonly stage: 'after-accepted-signal-failure';
      readonly pid: number;
      readonly signal: 'SIGTERM' | 'SIGKILL';
    }
  | {
      readonly stage: 'after-sigterm-grace';
      readonly pid: number;
      readonly signal: 'SIGTERM';
      readonly graceMs: number;
    }
  | {
      readonly stage: 'after-sigkill-grace';
      readonly pid: number;
      readonly signal: 'SIGKILL';
      readonly graceMs: number;
    };

type HandoffSignalCooldownContext = Readonly<{
  stage: 'before-signal';
  pid: number;
  requestedSignal: 'SIGTERM' | 'SIGKILL';
  previousSignal: 'SIGTERM' | 'SIGKILL';
  ageMs: number;
  retryInMs: number;
}>;

export type HandoffRefusalContextByCode = {
  readonly handoff_fresh_discovery_unavailable: HandoffVerificationContext;
  readonly handoff_fresh_discovery_changed: HandoffVerificationContext;
  readonly handoff_signal_capability_unavailable: HandoffVerificationContext & {
    readonly missingFields: readonly MissingSignalCapabilityField[];
  };
  readonly handoff_signal_cooldown_active: HandoffSignalCooldownContext;
  readonly handoff_legacy_signal_attempt_indeterminate: HandoffSignalCooldownContext;
  readonly handoff_shutdown_capability_rejected: Readonly<{
    stage: 'shutdown-request';
    pid: number | 'unknown';
  }>;
  readonly handoff_shutdown_credential_unavailable: Readonly<{
    stage: 'shutdown-request';
    pid: number;
  }>;
  readonly handoff_socket_holder_unverified: Readonly<{
    stage: 'handoff-deadline';
    socketPath: string;
  }>;
  readonly handoff_manual_policy: Readonly<{
    stage: 'before-signal';
    pid: number;
    policy: 'manual';
  }>;
  readonly handoff_term_only_policy: Readonly<{
    stage: 'after-sigterm-grace';
    pid: number;
    graceMs: number;
    policy: 'term-only';
  }>;
  readonly handoff_process_identity_unavailable: HandoffVerificationContext;
  readonly handoff_process_liveness_unknown: HandoffVerificationContext;
  readonly handoff_platform_identity_insufficient: HandoffVerificationContext;
  readonly handoff_published_incarnation_missing: HandoffVerificationContext;
  readonly handoff_published_incarnation_mismatch: HandoffVerificationContext;
  readonly handoff_signal_anchor_missing: HandoffVerificationContext;
  readonly handoff_pid_recycled: HandoffVerificationContext;
  readonly handoff_signal_rejected_live: Readonly<{
    stage: 'after-rejected-signal';
    pid: number;
    signal: 'SIGTERM' | 'SIGKILL';
  }>;
  readonly handoff_accepted_signal_target_alive_after_failure: Readonly<{
    stage: 'after-accepted-signal-failure';
    pid: number;
    signal: 'SIGTERM' | 'SIGKILL';
  }>;
  readonly handoff_accepted_signal_target_alive_after_bind: Readonly<{
    stage: 'after-accepted-signal-bind';
    pid: number;
    signal: 'SIGTERM' | 'SIGKILL';
  }>;
  readonly handoff_sigkill_grace_target_gone_socket_still_bound: Readonly<{
    stage: 'after-sigkill-grace';
    pid: number;
    signal: 'SIGKILL';
    graceMs: number;
  }>;
  readonly handoff_sigkill_grace_target_alive: Readonly<{
    stage: 'after-sigkill-grace';
    pid: number;
    signal: 'SIGKILL';
    graceMs: number;
  }>;
};

export type HandoffRefusalInit = {
  [Code in HandoffRefusalCode]: Readonly<{
    code: Code;
    context: HandoffRefusalContextByCode[Code];
  }>;
}[HandoffRefusalCode];

type AssertNever<Value extends never> = Value;

export type AssertHandoffRefusalContextCoversCodes = AssertNever<
  Exclude<HandoffRefusalCode, keyof HandoffRefusalContextByCode>
>;

export type AssertHandoffRefusalCodesCoverContext = AssertNever<
  Exclude<keyof HandoffRefusalContextByCode, HandoffRefusalCode>
>;

type DocumentedCoralSetupErrorContext<Code extends DocumentedCoralSetupErrorCode> =
  Code extends keyof HandoffRefusalContextByCode
    ? HandoffRefusalContextByCode[Code]
    : CoralSetupErrorContext | undefined;

type DocumentedCoralSetupErrorSpec<Code extends DocumentedCoralSetupErrorCode> = {
  readonly userMessage: string | ((context: DocumentedCoralSetupErrorContext<Code>) => string);
  readonly remediation: string | ((context: DocumentedCoralSetupErrorContext<Code>) => string);
  readonly exitCode?: number;
  readonly retryable?: true;
  readonly observation?: 'not_observed';
};

type DocumentedCoralSetupErrorCatalog = {
  readonly [Code in DocumentedCoralSetupErrorCode]: DocumentedCoralSetupErrorSpec<Code>;
};

function stringContextValue(context: CoralSetupErrorContext | undefined, key: string, fallback: string): string {
  const raw = context?.[key];
  return typeof raw === 'string' && raw.trim().length > 0 ? raw : fallback;
}

function interruptedStoreResetRemediation(context?: CoralSetupErrorContext): string {
  return `Run 'coral-cli backend store-reset discard --target gen2 --flavor ${stringContextValue(context, 'flavor', '<prod|dev>')}' to resume the interrupted reset under explicit operator control. Startup leaves the active store and staged incident unchanged.`;
}

function activeStoreCoordinationRemediation(context?: CoralSetupErrorContext): string {
  const recordPath = stringContextValue(context, 'recordPath', '<active-store-record>');
  const coordinationRoot = stringContextValue(context, 'coordinationRoot', '<coordination-directory>');
  const failureCode = stringContextValue(context, 'failureCode', 'unknown');
  const stop = "Run this build's own 'coral-cli backend shutdown'.";
  if (failureCode === 'record_mode') {
    return `${stop} Restore ${recordPath} to the current user's ownership with mode 0600, then retry the command. Preserve the record and store files if the refusal persists.`;
  }
  if (failureCode.startsWith('coordination_directory_')) {
    return `${stop} Restore ${coordinationRoot} as an ordinary canonical directory owned by the current user, then retry the command. Preserve the coordination records and store files if the refusal persists.`;
  }
  if (failureCode === 'record_link' || failureCode === 'record_not_regular') {
    return `${stop} Restore ${recordPath} as a regular non-link file owned by the current user with mode 0600, then retry the command. Preserve the existing entry and store files for diagnosis if its origin is unknown.`;
  }
  if (failureCode === 'record_changed' || failureCode === 'record_unavailable') {
    return `${stop} Verify that ${recordPath} is stable and both readable and writable by the current user, then retry the command. If it still fails, preserve the record and store files and report failureCode=${failureCode}.`;
  }
  return `${stop} Preserve ${recordPath} and the store files, then report this error with failureCode=${failureCode}; do not edit or delete the evidence.`;
}

function verificationLead(context: HandoffVerificationContext): string {
  switch (context.stage) {
    case 'before-signal':
      return `Handoff refused before signaling incumbent pid=${context.pid}`;
    case 'after-rejected-signal':
      return `Handoff refused after ${context.signal} was rejected for incumbent pid=${context.pid}`;
    case 'after-accepted-signal-bind':
      return `Handoff refused after the socket became bindable following accepted ${context.signal} for incumbent pid=${context.pid}`;
    case 'after-accepted-signal-failure':
      return `Handoff failed after accepted ${context.signal} for incumbent pid=${context.pid}`;
    case 'after-sigterm-grace':
      return `Handoff refused after accepted SIGTERM for incumbent pid=${context.pid} and its ${context.graceMs}ms grace elapsed`;
    case 'after-sigkill-grace':
      return `Handoff refused after accepted SIGKILL for incumbent pid=${context.pid} and its ${context.graceMs}ms grace elapsed`;
  }
}

const DOCUMENTED_CORAL_SETUP_ERRORS = {
  expansion_install_lock_contended: {
    userMessage: (context) =>
      `Another package operation is in progress for ${stringContextValue(context, 'name', 'this expansion')}.`,
    remediation:
      'Wait for the in-flight operation to complete, then retry. If this persists after ten minutes with no Coral process running, report the JSON error code and context; do not delete a live lock.',
  },
  expansion_install_command_failed: {
    userMessage: (context) =>
      `The install command for ${stringContextValue(context, 'name', 'this expansion')} failed.`,
    remediation: (context) => {
      const detail = stringContextValue(context, 'detail', '');
      const base = 'Check network access and the prerequisites named by the install script, then retry.';
      return detail.length > 0 ? `${detail}\n${base}` : base;
    },
  },
  expansion_install_artifact_failed: {
    userMessage: (context) =>
      `Coral could not install the runtime artifacts for ${stringContextValue(context, 'name', 'this expansion')}.`,
    remediation: (context) => {
      const detail = stringContextValue(context, 'detail', '');
      const base =
        `Check network access, filesystem permissions, and free space, then retry ` +
        `'coral-cli expansion equip ${stringContextValue(context, 'name', '<name>')}'.`;
      return detail.length > 0 ? `${detail}\n${base}` : base;
    },
  },
  startup_not_ready: {
    userMessage: 'Coral backend is still starting.',
    remediation: 'The Coral backend is still starting; retry shortly.',
    exitCode: 75,
  },
  startup_bundle_unresolvable: {
    userMessage: "Coral cannot resolve this installation's running backend bundle directory.",
    remediation: (context) =>
      `Reinstall or update the Coral plugin at ${stringContextValue(context, 'pluginRoot', '<plugin-root>')} so its bridge bundle and manifest are present, then start Coral again.`,
  },
  system_provider_scope_invalid: {
    userMessage: (context) => {
      const scopeName = stringContextValue(context, 'scopeName', '');
      return scopeName.length > 0
        ? `Named system provider scope '${scopeName}' is invalid.`
        : 'CORAL_SYSTEM_PROVIDER_SCOPE is not a valid named system provider scope.';
    },
    remediation: (context) =>
      stringContextValue(context, 'scopeName', '').length > 0
        ? 'Edit CORAL_SYSTEM_PROVIDER_SCOPE, remove the duplicate or invalid provider entry, and restart Coral.'
        : 'Set CORAL_SYSTEM_PROVIDER_SCOPE to a strict JSON object with origin "system", a non-empty name, and canonical provider profiles, or unset it to disable HTTP/internal provider execution.',
  },
  coordinator_socket_in_use: {
    userMessage: (context) =>
      `${stringContextValue(context, 'operation', 'This operator command')} requires the Coral coordinator socket to be unbound.`,
    remediation: (context) =>
      `Run 'coral-cli backend shutdown', wait for the coordinator to exit, then retry '${stringContextValue(context, 'retryCommand', '<operator-command>')}'.`,
  },
  coordinator_socket_bind_failed: {
    userMessage: (context) =>
      `Coral could not bind the coordinator socket at ${stringContextValue(context, 'socketPath', '<socket-path>')} for ${stringContextValue(context, 'operation', 'this operator command')}.`,
    remediation: (context) =>
      `Run 'coral-cli backend shutdown'. Check the socket parent directory, permissions, and platform path-length limit, then retry '${stringContextValue(context, 'retryCommand', '<operator-command>')}'.`,
  },
  coordinator_socket_dir_insecure: {
    userMessage: (context) =>
      `Coral's coordinator socket uses ${stringContextValue(context, 'directory', '<directory>')} as its fallback directory, and ${
        context?.reason === 'foreign'
          ? 'that path belongs to another user'
          : context?.reason === 'unusable'
            ? 'that path is not a directory'
            : `Coral cannot keep that path private to you (${stringContextValue(context, 'cause', 'cause unavailable')})`
      }.`,
    remediation: (context) =>
      context?.reason === 'unusable'
        ? `Remove ${stringContextValue(context, 'directory', '<directory>')} and start Coral again. Coral will not bind its singleton socket where it cannot establish exclusive ownership.`
        : context?.reason === 'foreign'
          ? `Ask the owner of ${stringContextValue(context, 'directory', '<directory>')}, or this host's administrator, to remove it — do not try to remove or repair it yourself. Coral will not bind its singleton socket where it cannot establish exclusive ownership.`
          : "Give this host's administrator the observation above. Coral did not bind its singleton socket. Start Coral again once the directory is repaired.",
  },
  coordinator_socket_dir_unverified: {
    userMessage: (context) => {
      const directory = stringContextValue(context, 'directory', '<directory>');
      const cause = stringContextValue(context, 'cause', 'cause unavailable');
      const observationNamesDirectory = cause.includes(directory);
      const location = observationNamesDirectory ? 'a fallback directory' : directory;
      const reference = observationNamesDirectory ? 'it' : 'that directory';
      return `Coral's coordinator socket uses ${location}, but Coral could not establish whether ${reference} is private to you (${cause}). This does not mean the directory is wrong.`;
    },
    remediation: (context) => {
      const cause = stringContextValue(context, 'cause', 'cause unavailable');
      if (cause === 'the required socket-directory owner uid is not usable') {
        return 'Start Coral in an environment that provides an owner uid the filesystem can represent for the fallback directory. Coral will not bind its singleton socket without a usable owner identity.';
      }
      if (cause.includes('reported no owner')) {
        return 'Start Coral on a filesystem that reports owner identity for the fallback directory. The observation succeeded but did not identify an owner, so Coral could not settle whether the directory is private.';
      }
      return 'Resolve the filesystem error reported in the observation above, then start Coral again. Coral will not bind its singleton socket in a directory it could not observe.';
    },
    exitCode: 75,
    observation: 'not_observed',
  },
  store_schema_outdated: {
    userMessage: 'Coral backend store format does not match this installation.',
    remediation: (context) => {
      const version = stringContextValue(context, 'version', '');
      const command = `'coral-cli backend store-reset discard --target gen2 --flavor ${stringContextValue(context, 'flavor', '<prod|dev>')}'`;
      return version.length > 0
        ? `This build cannot read this store's format. Use Coral ${version} to read this store, or deliberately destroy its history by running ${command}; this build can then initialize an empty store.`
        : `This build cannot read this store's format. To deliberately destroy its history, run ${command}; this build can then initialize an empty store.`;
    },
  },
  legacy_foreign_generation: {
    userMessage: (context) =>
      context?.operation === 'discard'
        ? `Coral cannot safely discard the foreign-generation tree at ${stringContextValue(context, 'legacyPath', '<legacy-path>')}.`
        : `The legacy Coral tree at ${stringContextValue(context, 'legacyPath', '<legacy-path>')} has stored Coral version ${stringContextValue(context, 'version', 'unknown')} and cannot be adopted by this build.`,
    remediation: (context) =>
      context?.operation === 'discard'
        ? `Close every older-version session that may use ${stringContextValue(context, 'legacyPath', '<legacy-path>')}; stored Coral version: ${stringContextValue(context, 'version', 'unknown')}. Then remove that tree yourself. This command refused without changing it. Active baseDir: ${stringContextValue(context, 'baseDir', '<base-dir>')}.`
        : `Use the Coral version that owns the history at ${stringContextValue(context, 'legacyPath', '<legacy-path>')} (stored version: ${stringContextValue(context, 'version', 'unknown')}). This build leaves that foreign-generation tree untouched.`,
  },
  legacy_source_not_quiescent: {
    userMessage: (context) =>
      `The generation-boundary operation cannot proceed while ${stringContextValue(context, 'holder', '<writer-lease-holder>')} remains active.`,
    remediation: (context) => {
      const retry = stringContextValue(
        context,
        'retryCommand',
        context?.operation === 'store-reset'
          ? `coral-cli backend store-reset discard --target gen2 --flavor ${stringContextValue(context, 'flavor', '<prod|dev>')}`
          : 'the operator command you ran',
      );
      return `Run this build's own 'coral-cli backend shutdown'. Wait for '${stringContextValue(context, 'holder', '<writer-lease-holder>')}' to exit and release its lease or lock, then retry '${retry}'.`;
    },
  },
  legacy_source_writer_observation_unknown: {
    userMessage: (context) =>
      `The generation-boundary operation cannot determine whether ${stringContextValue(context, 'holder', '<writer-lease-holder>')} is still active.`,
    remediation: (context) => {
      const retry = stringContextValue(
        context,
        'retryCommand',
        context?.operation === 'store-reset'
          ? `coral-cli backend store-reset discard --target gen2 --flavor ${stringContextValue(context, 'flavor', '<prod|dev>')}`
          : 'the operator command you ran',
      );
      return `Restore process-identity and liveness observation for '${stringContextValue(context, 'holder', '<writer-lease-holder>')}', then retry '${retry}'. If that writer has exited, its lease becomes reclaimable after ten minutes without a heartbeat; retry after that bound instead of deleting the lease.`;
    },
    exitCode: 75,
    observation: 'not_observed',
  },
  active_store_coordination_invalid: {
    userMessage: (context) =>
      `Coral cannot safely use the active-store ${stringContextValue(context, 'record', '<selection|transition>')} record.`,
    remediation: activeStoreCoordinationRemediation,
  },
  store_newer_incompatible: {
    userMessage: (context) =>
      `The current-generation store was written by newer Coral ${stringContextValue(context, 'version', '<stored-version>')} and is incompatible with this build.`,
    remediation: (context) =>
      `Use Coral ${stringContextValue(context, 'version', '<stored-version>')} to read this store, or run 'coral-cli backend store-reset discard --target gen2 --flavor ${stringContextValue(context, 'flavor', '<prod|dev>')}' to quarantine it before this build initializes an empty store.`,
  },
  store_older_incompatible: {
    userMessage: (context) =>
      `The current-generation store was written by Coral ${stringContextValue(context, 'version', '<stored-version>')} with an older incompatible format.`,
    remediation: (context) =>
      `Use Coral ${stringContextValue(context, 'version', '<stored-version>')} to read this store, or run 'coral-cli backend store-reset discard --target gen2 --flavor ${stringContextValue(context, 'flavor', '<prod|dev>')}' to quarantine it before this build initializes an empty store.`,
  },
  store_corrupt_or_unsupported: {
    userMessage: 'The current-generation store is corrupt or uses an unsupported format.',
    remediation: (context) =>
      `Run 'coral-cli backend store-reset discard --target gen2 --flavor ${stringContextValue(context, 'flavor', '<prod|dev>')}' to quarantine it before this build initializes an empty store.`,
  },
  store_open_contended: {
    userMessage: 'The current-generation store could not be opened because it is in use.',
    remediation: (context) =>
      `Wait for the other Coral process or store-inspection tool using ${stringContextValue(context, 'path', '<store-path>')} to finish its transaction or exit and release the SQLite lock, then retry. If the refusal persists after every such process has released the store, it is no longer ordinary contention; verify which process still has the store open and verify filesystem health before diagnosing the store. This error does not authorize discarding it.`,
    exitCode: 75,
    retryable: true,
  },
  store_open_unclassified: {
    userMessage: 'Coral could not classify why the current-generation store could not be opened.',
    remediation: (context) =>
      `Inspect error.context.cause in startup-diagnostic.json or the structured error payload, preserve the store at ${stringContextValue(context, 'path', '<store-path>')}, and report the code with that diagnostic cause. This refusal does not establish that the store is corrupt; do not discard it based on this error.`,
    exitCode: 70,
  },
  store_not_initialized: {
    userMessage: 'No Coral store exists yet for this installation.',
    remediation:
      'Only the coordinator creates the store. Run any normal Coral command so the coordinator starts and initializes it, then retry; read-only and non-daemon commands deliberately cannot create it.',
  },
  kb_commit_corrupt_or_unsupported: {
    userMessage: (context) => {
      const version = stringContextValue(context, 'version', '');
      return version.length > 0
        ? `KB commit '${stringContextValue(context, 'commitId', '<commit>')}' requires Coral ${version}.`
        : `KB commit '${stringContextValue(context, 'commitId', '<commit>')}' is corrupt or unsupported.`;
    },
    remediation: (context) => {
      const version = stringContextValue(context, 'version', '');
      const command = `'coral-cli backend kb-commit quarantine --flavor ${stringContextValue(context, 'flavor', '<prod|dev>')} --commit ${stringContextValue(context, 'commitId', '<commit>')}'`;
      return version.length > 0
        ? `Use Coral ${version} to read this commit, or run 'coral-cli backend shutdown' and then ${command} to quarantine the blocking KB artifacts.`
        : `Run 'coral-cli backend shutdown' and then ${command} to quarantine the blocking KB artifacts.`;
    },
  },
  kb_commit_id_invalid: {
    userMessage: 'KB commit ID must be one safe filesystem path segment.',
    remediation:
      "Copy the commit ID exactly from the kb_commit_corrupt_or_unsupported refusal; do not add a path, '.', or '..'.",
  },
  kb_commit_not_found: {
    userMessage: (context) =>
      `KB commit '${stringContextValue(context, 'commitId', '<commit>')}' is not present in the active commit evidence.`,
    remediation:
      "Start Coral again to obtain the current kb_commit_corrupt_or_unsupported refusal, then run 'coral-cli backend shutdown' and retry with that refusal's exact commit ID. Preserve any retained quarantine or staging evidence.",
  },
  kb_commit_already_quarantined: {
    userMessage: (context) =>
      `KB commit '${stringContextValue(context, 'commitId', '<commit>')}' already has retained quarantine evidence.`,
    remediation: (context) =>
      `Do not overwrite the retained evidence at ${stringContextValue(context, 'quarantineDir', '<quarantine-dir>')}. Start Coral again; if it still names this commit as blocking, report this code and path.`,
  },
  kb_commit_quarantine_failed: {
    userMessage: (context) =>
      `Coral could not durably quarantine KB commit '${stringContextValue(context, 'commitId', '<commit>')}'.`,
    remediation:
      'Check permissions and free disk space in the generated KB runtime directory, then retry the quarantine command. Preserve active, staging, and retained quarantine evidence.',
  },
  store_reset_lock_contended: {
    userMessage: (context) =>
      context?.holder === undefined
        ? 'Another Coral process is initializing the backend store.'
        : `Store reset refused because the ${stringContextValue(context, 'holder', 'target coordinator socket')} is already owned.`,
    remediation: (context) =>
      context?.holder === undefined
        ? "Run 'coral-cli backend shutdown', then retry shortly. If this persists after 30 seconds with no Coral process running, remove only the stale store.db.reset.lock directory."
        : `Run 'coral-cli backend shutdown' for the ${stringContextValue(context, 'target', '<legacy|gen2>')} ${stringContextValue(context, 'flavor', '<prod|dev>')} coordinator rooted at ${stringContextValue(context, 'baseDir', '<base-dir>')}, then retry. The discard command never shuts down an incumbent daemon.`,
  },
  store_reset_interrupted_ambiguous: {
    userMessage:
      'Coral found more than one interrupted backend store-reset publication and cannot determine which one to resume.',
    remediation: interruptedStoreResetRemediation,
  },
  store_reset_interrupted_foreign: {
    userMessage: 'Coral found an unrecognized entry in the interrupted backend store-reset staging area.',
    remediation: interruptedStoreResetRemediation,
  },
  store_reset_interrupted_mismatched: {
    userMessage:
      'Coral found interrupted backend store-reset evidence whose manifest identity does not match its staged publication.',
    remediation: interruptedStoreResetRemediation,
  },
  store_reset_interrupted_authority_mismatch: {
    userMessage:
      'Coral found an interrupted backend store-reset incident authored for a different build, store, or flavor.',
    remediation: interruptedStoreResetRemediation,
  },
  store_reset_interrupted_malformed: {
    userMessage: 'Coral found a malformed interrupted backend store-reset incident.',
    remediation: interruptedStoreResetRemediation,
  },
  store_reset_interrupted_non_resettable: {
    userMessage:
      'Coral found an interrupted legacy V2 backend store-reset incident that cannot be resumed automatically.',
    remediation: interruptedStoreResetRemediation,
  },
  store_reset_quarantine_failed: {
    userMessage: (context) =>
      context?.reason === 'interrupted'
        ? 'Coral detected an interrupted backend store reset and refused to resume it during startup.'
        : context?.reason === 'active_store_transition_evidence'
          ? 'Coral could not preserve a stale active-store transition before superseding it.'
          : context?.reason === 'classified_evidence_missing'
            ? 'Coral found no active backend store files to quarantine after classifying the store for reset.'
            : 'Coral could not quarantine the old backend store before reset.',
    remediation: (context) =>
      context?.reason === 'interrupted'
        ? interruptedStoreResetRemediation(context)
        : context?.reason === 'active_store_transition_evidence'
          ? 'Check permissions and free disk space in the Coral store directory, then retry; Coral republishes retained transition evidence itself on the next attempt. If this persists, report this code with its JSON context — do not hand-edit the active-store records or retained transition evidence.'
          : context?.reason === 'classified_evidence_missing'
            ? "Retry startup once. If the store is classified for reset again without any active files, run 'coral-cli backend status' and report this code. Do not create, move, delete, restore, or upload DB, WAL, or SHM evidence."
            : 'Check permissions and free disk space in the Coral store directory, then retry. Do not move, delete, restore, or upload DB, WAL, or SHM evidence.',
  },
  recovery_quarantine_boundary_not_registered: {
    userMessage: 'That recovery boundary is not available for operator retry.',
    remediation:
      'Run `coral-cli backend recovery-quarantine list` and copy the boundary from a retained row. If the listed boundary is still rejected, update Coral and retry.',
  },
  recovery_quarantine_subject_not_found: {
    userMessage: 'That recovery quarantine key does not name a retained row.',
    remediation:
      'Run `coral-cli backend recovery-quarantine list`, copy one row’s current boundary, key, and revision, then retry clear with that exact coordinate.',
  },
  recovery_quarantine_revision_changed: {
    userMessage: 'That recovery quarantine coordinate is stale because its revision changed.',
    remediation:
      'Run `coral-cli backend recovery-quarantine list`, copy the row’s current boundary, key, and revision, then retry clear with that exact coordinate.',
  },
  recovery_quarantine_continuation_pending: {
    userMessage: 'That recovery quarantine row is a durable continuation and cannot be cleared directly.',
    remediation:
      'Run `coral-cli backend recovery-quarantine list` to inspect the continuation. Leave it retained for the owning recovery flow; do not repeat clear with the same coordinate.',
  },
  recovery_quarantine_retry_in_progress: {
    userMessage: 'A recovery retry is already in progress for that quarantine row.',
    remediation:
      'Wait for the coordinator to finish the retry, then run `coral-cli backend recovery-quarantine list`. Retry clear only if the row returns to the active state.',
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
  /**
   * Documented rather than left to `unknown_error`, whose remediation is "retry once" — advice this code's own
   * remediation replaces with the record path and its actual clearing step. Exit 75, not 1: a coordinator can
   * be running fine behind a discovery record this build simply cannot read (wrong permissions, a truncated
   * write), so this run has not observed whether one exists — the same axis `coordinator_unreachable` sits on,
   * and the reason both belong in `NOT_OBSERVED_CORAL_SETUP_ERROR_CODES` together.
   */
  coordinator_record_unreadable: {
    userMessage: (context) =>
      `Coral cannot report ${stringContextValue(context, 'subject', 'expansion status')}: the coordinator discovery record at ${stringContextValue(context, 'path', '<record-path>')} could not be read (${stringContextValue(context, 'detail', 'unknown')}). This does not mean no coordinator is running.`,
    remediation: (context) =>
      `Fix the permissions on ${stringContextValue(context, 'path', '<record-path>')}, or delete it if its content is corrupt — a running coordinator never rewrites it, and a fresh one recreates it safely. Then run any coral-cli mutating command (or start a Claude Code session); it attempts startup or handoff. Retrying this exact command re-reads the same file and will not resolve on its own.`,
    exitCode: 75,
    observation: 'not_observed',
  },
  /**
   * Reached only once a record decoded — a coordinator claimed this socket at some point, and wrote that
   * record only after its own IPC listener was already bound — and its recorded pid was not observed absent.
   * That ordering is why a stale, crashed, or namespace-hidden coordinator is the likely cause rather than a
   * boot race; it stays exit 75 rather than 1 because a live coordinator that is merely too busy to answer one
   * connection attempt produces the identical evidence, and this code cannot tell the two apart. The
   * remediation therefore names its own exit — check the pid, then clear the record file directly — instead
   * of only "retry", which is the hold this split exists to close.
   */
  coordinator_unreachable: {
    userMessage: (context) =>
      `Coral cannot report ${stringContextValue(context, 'subject', 'expansion status')}: the coordinator recorded itself at ${stringContextValue(context, 'path', '<record-path>')} but did not answer (${stringContextValue(context, 'detail', 'unknown')}).`,
    remediation: (context) =>
      `Retry shortly in case the coordinator is only busy. If it persists, run 'ps -p ${stringContextValue(context, 'pid', '<pid>')}' or check your process manager to see whether that process is actually Coral's coordinator; if it is not, or you cannot tell, delete ${stringContextValue(context, 'path', '<record-path>')} yourself and run any coral-cli mutating command (or start a Claude Code session); it attempts startup or handoff.`,
    exitCode: 75,
    observation: 'not_observed',
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
      `Set ${stringContextValue(context, 'envVar', '<ENV>')} in the backend's environment (e.g. the \`env\` block of ~/.claude/settings.json), run 'coral-cli backend shutdown', then rerun \`coral-cli expansion equip ${stringContextValue(context, 'engine', '<engine>')}\`; it attempts startup or handoff with that environment.`,
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
  consumer_wait_fresh_invalid_target: {
    userMessage: (context) =>
      `Consumer ${stringContextValue(context, 'id', 'this consumer')} cannot satisfy waitFreshUntil — stateless provider lifecycle registrations have no cursor.`,
    remediation:
      'Use waitFreshUntil only with journal or corpus authority consumers. Stateless provider lifecycle registrations are not freshness targets.',
  },
  expansion_install_path_unwritable: {
    userMessage: (context) =>
      `Cannot write to the Coral expansion install path for ${stringContextValue(context, 'name', 'this expansion')}.`,
    remediation: 'Check filesystem permissions and free space under ~/.coral/data/engines/, then retry.',
  },
  retired_expansion_id_invalid: {
    userMessage: (context) =>
      `Retired expansion id '${stringContextValue(context, 'name', 'unknown')}' is unsafe or reserved.`,
    remediation:
      "Use the exact id shown by 'coral-cli expansion list'. Valid ids use lowercase letters, digits, and single hyphens and must not name a Coral-owned KB path.",
  },
  retired_expansion_cleanup_required: {
    userMessage: (context) =>
      `Retired expansion '${stringContextValue(context, 'name', 'this expansion')}' requires catalog cleanup.`,
    remediation: (context) =>
      `Run 'coral-cli expansion remove-catalog ${stringContextValue(context, 'name', '<name>')}' so Coral can remove its artifacts and state transactionally.`,
  },
  retired_expansion_consumer_active: {
    userMessage: (context) =>
      `Retired expansion '${stringContextValue(context, 'name', 'this expansion')}' still has an active consumer.`,
    remediation:
      'Stop the process hosting that consumer or shut down the Coral backend, then retry the remove-catalog command.',
  },
  retired_expansion_cleanup_in_progress: {
    userMessage: (context) =>
      `Retired expansion cleanup is already in progress for '${stringContextValue(context, 'name', 'this expansion')}'.`,
    remediation:
      "Wait for the current cleanup to finish, then run 'coral-cli expansion list'; if the residue remains, retry its cleanupCommand.",
  },
  retired_expansion_cursor_unsafe: {
    userMessage: (context) =>
      `Retired expansion '${stringContextValue(context, 'name', 'this expansion')}' has cursor metadata Coral cannot safely remove.`,
    remediation:
      'Do not delete the cursor or projection files manually. Preserve the store and report the JSON error code and context for repair.',
  },
  retired_expansion_cursor_changed: {
    userMessage: (context) =>
      `Retired expansion '${stringContextValue(context, 'name', 'this expansion')}' changed cursor ownership during cleanup.`,
    remediation:
      'Stop other Coral processes and retry. If it happens again, preserve the store and report the JSON error code and context.',
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
  // Transport-level distinction; CLI does not auto-retry on `_initializing`
  // and relies on the remediation hint instead.
  kb_initializing: {
    userMessage: 'Knowledge base is starting up — retry in ~5 seconds',
    remediation: 'Wait briefly, then retry the request',
    exitCode: 75,
  },
  kb_offline: {
    userMessage: 'Knowledge base is offline',
    remediation: 'Restart the daemon: coral-cli backend shutdown',
    exitCode: 75,
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
  capability_name_occupied: {
    userMessage: (context) => `Capability '${stringContextValue(context, 'name', 'unknown')}' is already registered.`,
    remediation: 'Use a unique capability name or remove the existing manifest declaration before registering another.',
  },
  capability_namespace_reserved: {
    userMessage: (context) =>
      `Capability '${stringContextValue(context, 'name', 'unknown')}' uses the reserved 'kb' namespace.`,
    remediation:
      "External manifests must declare capabilities outside the 'kb.*' namespace; only built-in KB composition may register 'kb.*' capabilities.",
  },
  capability_fill_unknown: {
    userMessage: (context) =>
      `Expansion '${stringContextValue(context, 'expansion', 'this expansion')}' fills unknown capability '${stringContextValue(context, 'name', 'unknown')}'.`,
    remediation: 'Declare the capability in a manifest or use an existing capability from the catalog.',
  },
  capability_fill_undeclared: {
    userMessage: (context) =>
      `Expansion '${stringContextValue(context, 'expansion', 'this expansion')}' tried to bind undeclared capability '${stringContextValue(context, 'name', 'unknown')}'.`,
    remediation: 'Add the capability to the manifest fills list before binding it at runtime.',
  },
  capability_require_undeclared: {
    userMessage: (context) =>
      `Expansion '${stringContextValue(context, 'expansion', 'this expansion')}' tried to read undeclared capability '${stringContextValue(context, 'name', 'unknown')}'.`,
    remediation: 'Add the capability to onboarding require-binding or retrieval role requirements before reading it.',
  },
  capability_descriptor_mismatch: {
    userMessage: (context) =>
      `Capability '${stringContextValue(context, 'name', 'unknown')}' does not match the registered descriptor.`,
    remediation:
      'Update the manifest descriptor to match the registered capability exactly, or remove the stale declaration before re-registering.',
  },
  capability_descriptor_unregistered: {
    userMessage: (context) =>
      `Expansion '${stringContextValue(context, 'expansion', 'this expansion')}' declared capability '${stringContextValue(context, 'name', 'unknown')}' but it was not registered.`,
    remediation: 'Run capability catalog initialization before validating manifest completeness.',
  },
  capability_required_by_active_engine: {
    userMessage: (context) =>
      `Capability removal for '${stringContextValue(context, 'target', 'this expansion')}' is blocked by an active engine dependency.`,
    remediation: 'Unequip active dependent engines before removing the capability provider.',
  },
  capability_catalog_remove_blocked: {
    userMessage: (context) =>
      `Catalog removal for '${stringContextValue(context, 'target', 'this expansion')}' is blocked by remaining capability dependents.`,
    remediation:
      'Remove or update every manifest that reads or fills the target capabilities before removing this catalog entry.',
  },
  require_binding_unknown: {
    userMessage: (context) =>
      `Onboarding requires unknown capability '${stringContextValue(context, 'name', 'unknown')}'.`,
    remediation:
      'Declare the capability in the catalog or update the onboarding requirement to use an existing capability.',
  },
  role_id_occupied: {
    userMessage: (context) =>
      `Retrieval role '${stringContextValue(context, 'roleId', 'unknown')}' is already registered.`,
    remediation: 'Use a unique retrieval role id or dispose the existing role before registering another one.',
  },
  role_descriptor_mismatch: {
    userMessage: (context) =>
      `Retrieval role '${stringContextValue(context, 'roleId', 'unknown')}' does not match the expansion manifest.`,
    remediation:
      'Update the expansion manifest and live retrieval role descriptor so id, label, tags, phase, scopes, requirements, and provided phase match.',
  },
  role_descriptor_unregistered: {
    userMessage: (context) =>
      `Expansion '${stringContextValue(context, 'expansion', 'this expansion')}' declared retrieval roles '${stringContextValue(context, 'missing', 'unknown')}' but did not register them.`,
    remediation:
      'Update the expansion to register every retrieval role declared in manifest.provides during startup, or remove the stale descriptor from the manifest.',
  },
  handoff_fresh_discovery_unavailable: {
    userMessage: (context) => `${verificationLead(context)}: fresh coordinator discovery was unavailable.`,
    remediation: 'Retry when verified discovery is available.',
    exitCode: 75,
    retryable: true,
    observation: 'not_observed',
  },
  handoff_fresh_discovery_changed: {
    userMessage: (context) => `${verificationLead(context)}: fresh coordinator discovery changed.`,
    remediation: 'Retry handoff against the newly discovered incumbent.',
    exitCode: 75,
    retryable: true,
  },
  handoff_signal_capability_unavailable: {
    userMessage: (context) =>
      `${verificationLead(context)}: verified discovery lacks required signal-capability fields (${context.missingFields.join(', ')}).`,
    remediation:
      'Repair or replace the coordinator discovery record, or stop the target through its host service, then retry handoff.',
    exitCode: 77,
  },
  handoff_signal_cooldown_active: {
    userMessage: (context) =>
      `Handoff refused before repeated ${context.requestedSignal} for incumbent pid=${context.pid}: the previous ${context.previousSignal} was ${context.ageMs}ms ago; retry in ${context.retryInMs}ms.`,
    remediation: (context) =>
      `Wait ${context.retryInMs}ms for the handoff signal cooldown to elapse, then retry handoff.`,
    exitCode: 75,
    retryable: true,
  },
  handoff_legacy_signal_attempt_indeterminate: {
    userMessage: (context) =>
      `Handoff refused before ${context.requestedSignal} for incumbent pid=${context.pid}: the legacy record proves only that ${context.previousSignal} was attempted ${context.ageMs}ms ago, not that it was accepted; retry in ${context.retryInMs}ms.`,
    remediation: (context) =>
      `Inspect the identified target and wait ${context.retryInMs}ms for the legacy attempt cooldown to elapse, then retry handoff.`,
    exitCode: 75,
    retryable: true,
    observation: 'not_observed',
  },
  handoff_shutdown_capability_rejected: {
    userMessage: (context) =>
      `Handoff refused during the shutdown request for incumbent pid=${context.pid}: the incumbent rejected the shutdown capability.`,
    remediation:
      'Stop the incumbent that owns the coordinator socket through the service or account that owns it, then retry handoff.',
    exitCode: 77,
  },
  handoff_shutdown_credential_unavailable: {
    userMessage: (context) =>
      `Handoff refused during the shutdown request for incumbent pid=${context.pid}: verified discovery had no boot credential for shutdown.`,
    remediation: 'Stop the identified incumbent through the service or account that owns it, then retry handoff.',
    exitCode: 77,
  },
  handoff_socket_holder_unverified: {
    userMessage: (context) =>
      `Handoff refused at the startup deadline for socket ${context.socketPath}: the socket remained bound but no verified holder pid was available.`,
    remediation:
      'Inspect and recover the process or stale socket that holds the coordinator socket, then retry handoff.',
    exitCode: 75,
    observation: 'not_observed',
  },
  handoff_manual_policy: {
    userMessage: (context) =>
      `Handoff refused before signaling incumbent pid=${context.pid}: ${HANDOFF_SIGNAL_POLICY_ENV}=manual forbids automated handoff signals.`,
    remediation: `Stop the target through the service or account that owns it, then retry handoff; or deliberately change ${HANDOFF_SIGNAL_POLICY_ENV} and retry.`,
    exitCode: 77,
  },
  handoff_term_only_policy: {
    userMessage: (context) =>
      `Handoff refused after accepted SIGTERM for incumbent pid=${context.pid} and its ${context.graceMs}ms grace elapsed: ${HANDOFF_SIGNAL_POLICY_ENV}=term-only forbids SIGKILL.`,
    remediation: `Wait for the target's own shutdown to finish or stop it through the service or account that owns it, then retry handoff; or deliberately change ${HANDOFF_SIGNAL_POLICY_ENV} and retry.`,
    exitCode: 77,
    retryable: true,
  },
  handoff_process_identity_unavailable: {
    userMessage: (context) =>
      `${verificationLead(context)}: the process incarnation was unavailable and pid absence was not established.`,
    remediation:
      'Retry when a fresh process-identity observation for this pid succeeds; if it remains unavailable, inspect and stop the target through its host service before retrying handoff.',
    exitCode: 75,
    retryable: true,
    observation: 'not_observed',
  },
  handoff_process_liveness_unknown: {
    userMessage: (context) =>
      `${verificationLead(context)}: the target identity matched but its current liveness could not be observed.`,
    remediation:
      'Retry when a process-liveness observation for this pid succeeds; if it remains unavailable, inspect and stop the target through its host service before retrying handoff.',
    exitCode: 75,
    retryable: true,
    observation: 'not_observed',
  },
  handoff_platform_identity_insufficient: {
    userMessage: (context) =>
      `${verificationLead(context)}: this platform cannot produce a process identity strong enough to authorize a signal.`,
    remediation: 'Stop the Coral backend through its service or socket, not by pid, then retry handoff.',
    exitCode: 77,
  },
  handoff_published_incarnation_missing: {
    userMessage: (context) =>
      `${verificationLead(context)}: the incumbent published no incarnation, so this pid cannot be proven to be it.`,
    remediation: 'Stop the Coral backend through its service or socket, not by this pid, then retry handoff.',
    exitCode: 77,
  },
  handoff_published_incarnation_mismatch: {
    userMessage: (context) => `${verificationLead(context)}: this pid is not the process the incumbent published.`,
    remediation:
      'Retry handoff against a freshly discovered incumbent; if the mismatch persists, stop the target through its host service before retrying handoff.',
    exitCode: 75,
    retryable: true,
  },
  handoff_signal_anchor_missing: {
    userMessage: (context) =>
      `${verificationLead(context)}: no baseline was observed for this pid while it was authenticated.`,
    remediation:
      'Retry handoff so a new attempt can establish an authenticated baseline; if it cannot, stop the target through its host service before retrying handoff.',
    exitCode: 75,
    retryable: true,
    observation: 'not_observed',
  },
  handoff_pid_recycled: {
    userMessage: (context) => `${verificationLead(context)}: the pid was recycled after this coordinator observed it.`,
    remediation:
      'Retry handoff against the current incumbent; if ownership remains unclear, stop it through its host service before retrying handoff.',
    exitCode: 75,
    retryable: true,
  },
  handoff_signal_rejected_live: {
    userMessage: (context) =>
      `Handoff refused after ${context.signal} was rejected for incumbent pid=${context.pid}: the verified target remained alive; this process may lack permission or the target may be outside its signal reach.`,
    remediation: 'Stop the target through the service or account that owns it, then retry handoff.',
    exitCode: 77,
  },
  handoff_accepted_signal_target_alive_after_failure: {
    userMessage: (context) =>
      `Handoff failed after accepted ${context.signal} for incumbent pid=${context.pid}: the target was not observed gone before another handoff operation failed.`,
    remediation:
      'Wait for the identified target to finish shutting down or stop it through the service or account that owns it, then retry startup.',
    exitCode: 69,
    retryable: true,
  },
  handoff_accepted_signal_target_alive_after_bind: {
    userMessage: (context) =>
      `Handoff refused after the socket became bindable following accepted ${context.signal} for incumbent pid=${context.pid}: the verified target remained alive.`,
    remediation:
      'Wait for the identified target to finish shutting down or stop it through the service or account that owns it, then retry startup.',
    exitCode: 69,
    retryable: true,
  },
  handoff_sigkill_grace_target_gone_socket_still_bound: {
    userMessage: (context) =>
      `Handoff refused after accepted SIGKILL for incumbent pid=${context.pid} and its ${context.graceMs}ms grace elapsed: the target is gone, but the coordinator socket remained bound.`,
    remediation:
      'Retry the original coral-cli mutating command so Coral re-observes ownership and removes the socket only if it proves stale.',
    exitCode: 75,
    retryable: true,
  },
  handoff_sigkill_grace_target_alive: {
    userMessage: (context) =>
      `Handoff refused after accepted SIGKILL for incumbent pid=${context.pid} and its ${context.graceMs}ms grace elapsed: the verified target remained alive.`,
    remediation: (context) =>
      `Wait for uninterruptible I/O to finish or stop pid=${context.pid} through its host service, then retry startup.`,
    exitCode: 69,
    retryable: true,
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
} satisfies DocumentedCoralSetupErrorCatalog;

type DocumentedCoralSetupErrorDisposition = Readonly<{
  exitCode?: number;
  retryable?: true;
  observation?: 'not_observed';
}>;

function documentedCoralSetupErrorSpec(code: string): DocumentedCoralSetupErrorDisposition | undefined;
function documentedCoralSetupErrorSpec(
  code: string,
): DocumentedCoralSetupErrorCatalog[DocumentedCoralSetupErrorCode] | undefined {
  if (!Object.hasOwn(DOCUMENTED_CORAL_SETUP_ERRORS, code)) {
    return undefined;
  }
  return DOCUMENTED_CORAL_SETUP_ERRORS[code as DocumentedCoralSetupErrorCode];
}

/**
 * Any documented code may be recorded in a coordinator startup diagnostic and re-rendered from this registry
 * by `backend status`, so a consumer that must decide about every remediation cannot enumerate them itself.
 */
export const DOCUMENTED_CORAL_SETUP_ERROR_CODES: readonly DocumentedCoralSetupErrorCode[] = Object.freeze(
  Object.keys(DOCUMENTED_CORAL_SETUP_ERRORS) as DocumentedCoralSetupErrorCode[],
);

/** Exit 75 must not be read as a settled negative verdict or as a promise that retrying will resolve it. */
export const NOT_OBSERVED_CORAL_SETUP_ERROR_CODES: ReadonlySet<string> = new Set<DocumentedCoralSetupErrorCode>(
  DOCUMENTED_CORAL_SETUP_ERROR_CODES.filter(
    (code) => documentedCoralSetupErrorSpec(code)?.observation === 'not_observed',
  ),
);

/** A documented code's exit must come from its registry entry, including the default exit 1. */
export function documentedCoralSetupErrorExitCode(code: string): number | undefined {
  const spec = documentedCoralSetupErrorSpec(code);
  return spec === undefined ? undefined : (spec.exitCode ?? 1);
}

/** Undocumented failures must remain non-retryable because no authored policy can justify retry. */
export function isRetryableCoralSetupError(error: unknown): boolean {
  const setupError = serializeCoralSetupError(error);
  return setupError !== null && documentedCoralSetupErrorSpec(setupError.code)?.retryable === true;
}

function renderDocumentedSpec<Code extends DocumentedCoralSetupErrorCode>(
  value: string | ((context: DocumentedCoralSetupErrorContext<Code>) => string),
  context: DocumentedCoralSetupErrorContext<Code>,
): string {
  return typeof value === 'function' ? value(context) : value;
}

function renderDocumentedCoralSetupError<Code extends DocumentedCoralSetupErrorCode>(
  code: Code,
  context: DocumentedCoralSetupErrorContext<Code>,
): Pick<CoralSetupErrorInit, 'userMessage' | 'remediation'> {
  const spec = DOCUMENTED_CORAL_SETUP_ERRORS[code] as DocumentedCoralSetupErrorSpec<Code>;
  return {
    userMessage: renderDocumentedSpec(spec.userMessage, context),
    remediation: renderDocumentedSpec(spec.remediation, context),
  };
}

export function renderHandoffRefusal(init: HandoffRefusalInit): CoralSetupErrorInit {
  const rendered = renderDocumentedCoralSetupError(init.code, init.context);
  return {
    code: init.code,
    ...rendered,
    context: init.context,
  };
}

export type DocumentedCoralSetupErrorObjectInit = {
  readonly code: DocumentedCoralSetupErrorCode;
  readonly context?: CoralSetupErrorContext;
  readonly userMessage?: string;
  readonly remediation?: string;
} & Record<string, unknown>;

export function documentedCoralSetupError(init: DocumentedCoralSetupErrorObjectInit): CoralSetupError;
export function documentedCoralSetupError(
  code: DocumentedCoralSetupErrorCode,
  context?: CoralSetupErrorContext,
  overrides?: Partial<Pick<CoralSetupErrorInit, 'userMessage' | 'remediation'>>,
): CoralSetupError;
export function documentedCoralSetupError(
  codeOrInit: DocumentedCoralSetupErrorCode | DocumentedCoralSetupErrorObjectInit,
  context?: CoralSetupErrorContext,
  overrides: Partial<Pick<CoralSetupErrorInit, 'userMessage' | 'remediation'>> = {},
): CoralSetupError {
  const { code, effectiveContext, effectiveOverrides } =
    typeof codeOrInit === 'string'
      ? { code: codeOrInit, effectiveContext: context, effectiveOverrides: overrides }
      : normalizeDocumentedSetupErrorInit(codeOrInit);
  const rendered = renderDocumentedCoralSetupError(code, effectiveContext);

  return new CoralSetupError({
    code,
    userMessage: effectiveOverrides.userMessage ?? rendered.userMessage,
    remediation: effectiveOverrides.remediation ?? rendered.remediation,
    ...(effectiveContext === undefined ? {} : { context: effectiveContext }),
  });
}

function normalizeDocumentedSetupErrorInit(init: DocumentedCoralSetupErrorObjectInit): {
  readonly code: DocumentedCoralSetupErrorCode;
  readonly effectiveContext: CoralSetupErrorContext | undefined;
  readonly effectiveOverrides: Partial<Pick<CoralSetupErrorInit, 'userMessage' | 'remediation'>>;
} {
  const { code, context, userMessage, remediation, ...contextFields } = init;
  let effectiveContext = context;
  if (effectiveContext === undefined && Object.keys(contextFields).length > 0) {
    effectiveContext = contextFields;
  }
  return {
    code,
    effectiveContext,
    effectiveOverrides: {
      ...(userMessage === undefined ? {} : { userMessage }),
      ...(remediation === undefined ? {} : { remediation }),
    },
  };
}

export class CoralSetupError extends Error {
  readonly code: string;
  readonly userMessage: string;
  readonly remediation: string;
  readonly context?: Record<string, unknown>;

  constructor(init: CoralSetupErrorInit, options?: ErrorOptions) {
    super(init.userMessage, options);
    this.name = 'CoralSetupError';
    this.code = init.code;
    this.userMessage = init.userMessage;
    this.remediation = init.remediation;
    this.context = init.context;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isSerializedCoralSetupError(error: unknown): error is SerializedCoralSetupError {
  return (
    isRecord(error) &&
    typeof error.code === 'string' &&
    typeof error.userMessage === 'string' &&
    typeof error.remediation === 'string'
  );
}

const MAX_OPERATOR_FACING_CONTEXT_STRING_LENGTH = 512;
const MAX_OPERATOR_FACING_PROSE_LENGTH = 1_024;
const MAX_OPERATOR_FACING_CONTEXT_NUMBER = 1_000_000_000_000;
const SETUP_ERROR_IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const OPERATOR_FACING_CONTEXT_KEY_PATTERN = /^[a-z][A-Za-z0-9]*$/;
/**
 * Characters no operator-facing value may carry, whether it arrived as a path, a context value, or recorded
 * prose. A line break belongs here for the same reason an escape sequence does: the surfaces that render
 * these build their output line by line, so an embedded break forges a line the renderer never wrote.
 */
const OPERATOR_FACING_UNSAFE_CHARACTER_PATTERN = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const MAX_SETUP_ERROR_IDENTIFIER_LENGTH = 128;
const MAX_OPERATOR_FACING_CONTEXT_KEY_LENGTH = 128;

const OPERATOR_FACING_FILESYSTEM_CONTEXT_KEYS: ReadonlySet<string> = new Set([
  'baseDir',
  'coordinationRoot',
  'directory',
  'legacyPath',
  'path',
  'pluginRoot',
  'quarantineDir',
  'recordPath',
  'socketPath',
]);

/**
 * An elapsed measurement spanning two clock reads may come back negative when the wall clock steps
 * backward, and that sign is the evidence of the step. Every other operator-facing number is a count, a
 * duration, or a bound and may not be negative.
 */
const OPERATOR_FACING_SIGNED_CONTEXT_KEYS: ReadonlySet<string> = new Set(['ageMs']);

const OPERATOR_FACING_CLOSED_CONTEXT_VALUES: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  stage: new Set<HandoffRefusalContextByCode[HandoffRefusalCode]['stage']>([
    'before-signal',
    'after-rejected-signal',
    'after-accepted-signal-bind',
    'after-accepted-signal-failure',
    'after-sigterm-grace',
    'after-sigkill-grace',
    'shutdown-request',
    'handoff-deadline',
  ]),
  signal: new Set(['SIGTERM', 'SIGKILL']),
  requestedSignal: new Set(['SIGTERM', 'SIGKILL']),
  previousSignal: new Set(['SIGTERM', 'SIGKILL']),
  policy: new Set(['manual', 'term-only']),
});

function parseSetupErrorIdentifier(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_SETUP_ERROR_IDENTIFIER_LENGTH ||
    !SETUP_ERROR_IDENTIFIER_PATTERN.test(value)
  ) {
    return null;
  }
  return value;
}

function parseOperatorFacingContextKey(value: string): string | null {
  if (
    value.length === 0 ||
    value.length > MAX_OPERATOR_FACING_CONTEXT_KEY_LENGTH ||
    !OPERATOR_FACING_CONTEXT_KEY_PATTERN.test(value)
  ) {
    return null;
  }
  return value;
}

function isMissingSignalCapabilityFields(value: unknown): value is readonly MissingSignalCapabilityField[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 3 &&
    value.every(
      (field): field is MissingSignalCapabilityField =>
        field === 'instanceId' || field === 'token' || field === 'bootToken',
    )
  );
}

/**
 * An open-text context value carries an observation this build did not author — an errno message, a foreign
 * path, a filesystem's own words — and a remediation may branch on reading it. Its bound is therefore what
 * the rendering surfaces cannot carry and no narrower, the same bound recorded prose is held to: dropping
 * the value silently takes whichever branch assumes it was never observed.
 */
function canonicalOperatorFacingContextValue(key: string, value: unknown): unknown | undefined {
  if (key === 'missingFields') {
    if (!isMissingSignalCapabilityFields(value)) return undefined;
    return [...new Set(value)];
  }

  if (typeof value === 'string') {
    if (value.length === 0 || value.length > MAX_OPERATOR_FACING_CONTEXT_STRING_LENGTH) {
      return undefined;
    }
    if (OPERATOR_FACING_FILESYSTEM_CONTEXT_KEYS.has(key)) {
      return OPERATOR_FACING_UNSAFE_CHARACTER_PATTERN.test(value) || !isAbsolute(value) || normalize(value) !== value
        ? undefined
        : value;
    }
    if (value !== value.trim() || OPERATOR_FACING_UNSAFE_CHARACTER_PATTERN.test(value)) return undefined;
    const closedValues = OPERATOR_FACING_CLOSED_CONTEXT_VALUES[key];
    return closedValues === undefined || closedValues.has(value) ? value : undefined;
  }

  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    const lowerBound = OPERATOR_FACING_SIGNED_CONTEXT_KEYS.has(key) ? -MAX_OPERATOR_FACING_CONTEXT_NUMBER : 0;
    if (value >= lowerBound && value <= MAX_OPERATOR_FACING_CONTEXT_NUMBER) {
      return value;
    }
  }

  return undefined;
}

function canonicalOperatorFacingSetupErrorContext(value: unknown): CoralSetupErrorContext {
  const context: CoralSetupErrorContext = {};
  if (!isRecord(value)) return context;

  for (const [key, raw] of Object.entries(value)) {
    if (parseOperatorFacingContextKey(key) === null) continue;
    const canonical = canonicalOperatorFacingContextValue(key, raw);
    if (canonical !== undefined) context[key] = canonical;
  }
  return context;
}

function hasExactContextKeys(context: CoralSetupErrorContext, keys: readonly string[]): boolean {
  const contextKeys = Object.keys(context);
  return contextKeys.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(context, key));
}

function isSignal(value: unknown): value is 'SIGTERM' | 'SIGKILL' {
  return value === 'SIGTERM' || value === 'SIGKILL';
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number';
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isLiteral<const Value extends string>(...expected: readonly Value[]) {
  return (value: unknown): value is Value => typeof value === 'string' && expected.includes(value as Value);
}

type ContextShape<Context extends CoralSetupErrorContext> = {
  readonly [Key in keyof Context]-?: (value: unknown) => value is Context[Key];
};

function contextValidator<Context extends CoralSetupErrorContext>(
  shape: ContextShape<Context>,
): (context: CoralSetupErrorContext) => context is Context {
  const keys = Object.keys(shape);
  return (context): context is Context =>
    hasExactContextKeys(context, keys) && keys.every((key) => shape[key as keyof Context](context[key]));
}

function isHandoffVerificationContext(
  context: CoralSetupErrorContext,
  additionalKeys: readonly string[] = [],
): context is HandoffVerificationContext {
  if (typeof context.pid !== 'number') return false;
  switch (context.stage) {
    case 'before-signal':
      return hasExactContextKeys(context, ['stage', 'pid', ...additionalKeys]);
    case 'after-rejected-signal':
    case 'after-accepted-signal-bind':
    case 'after-accepted-signal-failure':
      return isSignal(context.signal) && hasExactContextKeys(context, ['stage', 'pid', 'signal', ...additionalKeys]);
    case 'after-sigterm-grace':
      return (
        context.signal === 'SIGTERM' &&
        typeof context.graceMs === 'number' &&
        hasExactContextKeys(context, ['stage', 'pid', 'signal', 'graceMs', ...additionalKeys])
      );
    case 'after-sigkill-grace':
      return (
        context.signal === 'SIGKILL' &&
        typeof context.graceMs === 'number' &&
        hasExactContextKeys(context, ['stage', 'pid', 'signal', 'graceMs', ...additionalKeys])
      );
    default:
      return false;
  }
}

function isSignalCapabilityContext(
  context: CoralSetupErrorContext,
): context is HandoffRefusalContextByCode['handoff_signal_capability_unavailable'] {
  const missingFields: unknown = context.missingFields;
  return isHandoffVerificationContext(context, ['missingFields']) && isMissingSignalCapabilityFields(missingFields);
}

const isSignalCooldownContext = contextValidator<HandoffRefusalContextByCode['handoff_signal_cooldown_active']>({
  stage: isLiteral('before-signal'),
  pid: isNumber,
  requestedSignal: isSignal,
  previousSignal: isSignal,
  ageMs: isNumber,
  retryInMs: isNumber,
});

const isShutdownCapabilityRejectedContext = contextValidator<
  HandoffRefusalContextByCode['handoff_shutdown_capability_rejected']
>({
  stage: isLiteral('shutdown-request'),
  pid: (value): value is number | 'unknown' => isNumber(value) || value === 'unknown',
});

const isShutdownCredentialUnavailableContext = contextValidator<
  HandoffRefusalContextByCode['handoff_shutdown_credential_unavailable']
>({ stage: isLiteral('shutdown-request'), pid: isNumber });

const isSocketHolderUnverifiedContext = contextValidator<
  HandoffRefusalContextByCode['handoff_socket_holder_unverified']
>({ stage: isLiteral('handoff-deadline'), socketPath: isString });

const isManualPolicyContext = contextValidator<HandoffRefusalContextByCode['handoff_manual_policy']>({
  stage: isLiteral('before-signal'),
  pid: isNumber,
  policy: isLiteral('manual'),
});

const isTermOnlyPolicyContext = contextValidator<HandoffRefusalContextByCode['handoff_term_only_policy']>({
  stage: isLiteral('after-sigterm-grace'),
  pid: isNumber,
  graceMs: isNumber,
  policy: isLiteral('term-only'),
});

const isRejectedSignalContext = contextValidator<HandoffRefusalContextByCode['handoff_signal_rejected_live']>({
  stage: isLiteral('after-rejected-signal'),
  pid: isNumber,
  signal: isSignal,
});

const isAcceptedSignalFailureContext = contextValidator<
  HandoffRefusalContextByCode['handoff_accepted_signal_target_alive_after_failure']
>({ stage: isLiteral('after-accepted-signal-failure'), pid: isNumber, signal: isSignal });

const isAcceptedSignalBindContext = contextValidator<
  HandoffRefusalContextByCode['handoff_accepted_signal_target_alive_after_bind']
>({ stage: isLiteral('after-accepted-signal-bind'), pid: isNumber, signal: isSignal });

const isSigkillGraceContext = contextValidator<HandoffRefusalContextByCode['handoff_sigkill_grace_target_alive']>({
  stage: isLiteral('after-sigkill-grace'),
  pid: isNumber,
  signal: isLiteral('SIGKILL'),
  graceMs: isNumber,
});

type HandoffRefusalContextValidator<Code extends HandoffRefusalCode> = (
  context: CoralSetupErrorContext,
) => context is HandoffRefusalContextByCode[Code];

const HANDOFF_REFUSAL_CONTEXT_VALIDATORS = {
  handoff_fresh_discovery_unavailable: isHandoffVerificationContext,
  handoff_fresh_discovery_changed: isHandoffVerificationContext,
  handoff_signal_capability_unavailable: isSignalCapabilityContext,
  handoff_signal_cooldown_active: isSignalCooldownContext,
  handoff_legacy_signal_attempt_indeterminate: isSignalCooldownContext,
  handoff_shutdown_capability_rejected: isShutdownCapabilityRejectedContext,
  handoff_shutdown_credential_unavailable: isShutdownCredentialUnavailableContext,
  handoff_socket_holder_unverified: isSocketHolderUnverifiedContext,
  handoff_manual_policy: isManualPolicyContext,
  handoff_term_only_policy: isTermOnlyPolicyContext,
  handoff_process_identity_unavailable: isHandoffVerificationContext,
  handoff_process_liveness_unknown: isHandoffVerificationContext,
  handoff_platform_identity_insufficient: isHandoffVerificationContext,
  handoff_published_incarnation_missing: isHandoffVerificationContext,
  handoff_published_incarnation_mismatch: isHandoffVerificationContext,
  handoff_signal_anchor_missing: isHandoffVerificationContext,
  handoff_pid_recycled: isHandoffVerificationContext,
  handoff_signal_rejected_live: isRejectedSignalContext,
  handoff_accepted_signal_target_alive_after_failure: isAcceptedSignalFailureContext,
  handoff_accepted_signal_target_alive_after_bind: isAcceptedSignalBindContext,
  handoff_sigkill_grace_target_gone_socket_still_bound: isSigkillGraceContext,
  handoff_sigkill_grace_target_alive: isSigkillGraceContext,
} satisfies { readonly [Code in HandoffRefusalCode]: HandoffRefusalContextValidator<Code> };

function isHandoffRefusalCode(code: DocumentedCoralSetupErrorCode): code is HandoffRefusalCode {
  return Object.prototype.hasOwnProperty.call(HANDOFF_REFUSAL_CONTEXT_VALIDATORS, code);
}

function provenAuthorIdentity(identity: SetupErrorAuthorIdentity | null): SetupErrorAuthorIdentity | null {
  if (identity === null) return null;
  return identity.bundleHash.trim().length > 0 && identity.namespace.trim().length > 0 ? identity : null;
}

function setupErrorAuthorship(kind: SetupErrorAuthorshipKind): SetupErrorAuthorship {
  return Object.freeze({ kind, [setupErrorAuthorshipProof]: true as const });
}

/**
 * `self` must be an identity this build proved, not one it read back from the same artifact family the
 * record came from; a fallback both sides share is not evidence of common authorship.
 */
export function resolveSetupErrorAuthorship(evidence: {
  readonly recorded: SetupErrorAuthorIdentity | null;
  readonly self: SetupErrorAuthorIdentity | null;
}): SetupErrorAuthorship {
  const recorded = provenAuthorIdentity(evidence.recorded);
  const self = provenAuthorIdentity(evidence.self);
  if (recorded === null || self === null) {
    return setupErrorAuthorship('unprovable');
  }
  return setupErrorAuthorship(
    recorded.bundleHash === self.bundleHash && recorded.namespace === self.namespace ? 'this-build' : 'other-build',
  );
}

function canonicalSelfAuthoredProse(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text.length === 0 || text.length > MAX_OPERATOR_FACING_PROSE_LENGTH) return null;
  return OPERATOR_FACING_UNSAFE_CHARACTER_PATTERN.test(text) ? null : text;
}

/**
 * A code with no catalog entry has no text to regenerate, so the record's own prose is the only text there
 * is. Showing it requires both halves: proven authorship bounds who wrote the record, and the character and
 * length bounds are what bound what that writer interpolated into it. Neither substitutes for the other.
 */
function readSelfAuthoredCoralSetupError(
  code: string,
  error: Record<string, unknown>,
  authorship: SetupErrorAuthorship,
): OperatorFacingCoralSetupError {
  if (authorship.kind !== 'this-build') {
    return { kind: 'unrecognized_code', code, authorship: authorship.kind };
  }
  const userMessage = canonicalSelfAuthoredProse(error.userMessage);
  const remediation = canonicalSelfAuthoredProse(error.remediation);
  if (userMessage === null || remediation === null) {
    return { kind: 'unrecognized_code', code, authorship: authorship.kind };
  }
  return { kind: 'self_authored', code, userMessage, remediation };
}

/**
 * A documented code's operator text is regenerated from the catalog, whoever wrote the record: the recorded
 * prose was rendered from context this build never validated, and the catalog renders from context it did.
 */
export function readOperatorFacingCoralSetupError(
  error: unknown,
  authorship: SetupErrorAuthorship,
): OperatorFacingCoralSetupError {
  if (!isRecord(error)) {
    return { kind: 'invalid_diagnostic' };
  }
  const parsedCode = parseSetupErrorIdentifier(error.code);
  if (parsedCode === null) {
    return { kind: 'invalid_diagnostic' };
  }
  if (documentedCoralSetupErrorSpec(parsedCode) === undefined) {
    return readSelfAuthoredCoralSetupError(parsedCode, error, authorship);
  }

  const code = parsedCode as DocumentedCoralSetupErrorCode;
  const canonicalContext = canonicalOperatorFacingSetupErrorContext(error.context);
  if (isHandoffRefusalCode(code)) {
    const validateContext: (context: CoralSetupErrorContext) => boolean = HANDOFF_REFUSAL_CONTEXT_VALIDATORS[code];
    if (!validateContext(canonicalContext)) {
      return { kind: 'invalid_diagnostic' };
    }
  }
  let authored: CoralSetupError;
  try {
    authored = documentedCoralSetupError(code, canonicalContext);
  } catch {
    return { kind: 'invalid_diagnostic' };
  }
  return {
    kind: 'documented',
    code,
    userMessage: authored.userMessage,
    remediation: authored.remediation,
  };
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

export function rehydrateCoralSetupError(error: unknown): CoralSetupError | null {
  const serialized = serializeCoralSetupError(error);
  return serialized === null ? null : new CoralSetupError(serialized);
}
