// Canonical setup-error registry. Holds the cross-cutting CoralSetupError
// class together with its documented code catalog. An error code catalog is
// a *registry of typed identifiers* — a single canonical home is the right
// shape (analogous to HTTP status codes, POSIX errno, SQLSTATE). The "magnet"
// anti-pattern only applies to files that absorb unrelated *logic*
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
  | 'expansion_install_lock_contended'
  | 'expansion_install_command_failed'
  | 'expansion_install_artifact_failed'
  | 'startup_not_ready'
  | 'startup_bundle_unresolvable'
  | 'coordinator_socket_in_use'
  | 'coordinator_socket_bind_failed'
  | 'store_schema_outdated'
  | 'legacy_foreign_generation'
  | 'legacy_source_not_quiescent'
  | 'active_store_coordination_invalid'
  | 'store_newer_incompatible'
  | 'store_older_incompatible'
  | 'store_corrupt_or_unsupported'
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
  | 'recovery_quarantine_revision_changed'
  | 'recovery_quarantine_continuation_pending'
  | 'recovery_quarantine_retry_in_progress'
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
  | 'user_cancelled';

type DocumentedCoralSetupErrorSpec = {
  readonly userMessage: string | ((context?: CoralSetupErrorContext) => string);
  readonly remediation: string | ((context?: CoralSetupErrorContext) => string);
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
  },
  startup_bundle_unresolvable: {
    userMessage: "Coral cannot resolve this installation's running backend bundle directory.",
    remediation: (context) =>
      `Reinstall or update the Coral plugin at ${stringContextValue(context, 'pluginRoot', '<plugin-root>')} so its bridge bundle and manifest are present, then start Coral again.`,
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
      `Set ${stringContextValue(context, 'envVar', '<ENV>')} in the backend's environment (e.g. the \`env\` block of ~/.claude/settings.json), run 'coral-cli backend shutdown' so the next command relaunches with it, then rerun \`coral-cli expansion equip ${stringContextValue(context, 'engine', '<engine>')}\`.`,
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
  },
  kb_offline: {
    userMessage: 'Knowledge base is offline',
    remediation: 'Restart the daemon: coral-cli backend shutdown',
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
  const spec = DOCUMENTED_CORAL_SETUP_ERRORS[code];

  return new CoralSetupError({
    code,
    userMessage: effectiveOverrides.userMessage ?? renderDocumentedSpec(spec.userMessage, effectiveContext),
    remediation: effectiveOverrides.remediation ?? renderDocumentedSpec(spec.remediation, effectiveContext),
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

export function isSerializedCoralSetupError(error: unknown): error is SerializedCoralSetupError {
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

export function rehydrateCoralSetupError(error: unknown): CoralSetupError | null {
  const serialized = serializeCoralSetupError(error);
  return serialized === null ? null : new CoralSetupError(serialized);
}
