import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  type AssertHandoffRefusalCodesCoverContext,
  type AssertHandoffRefusalContextCoversCodes,
  CoralSetupError,
  DOCUMENTED_CORAL_SETUP_ERROR_CODES,
  NOT_OBSERVED_CORAL_SETUP_ERROR_CODES,
  documentedCoralSetupError,
  documentedCoralSetupErrorExitCode,
  isRetryableCoralSetupError,
  readOperatorFacingCoralSetupError,
  renderHandoffRefusal,
  resolveSetupErrorAuthorship,
  type DocumentedCoralSetupErrorCode,
  type HandoffRefusalCode,
  type HandoffRefusalContextByCode,
  type HandoffRefusalInit,
  type OperatorFacingCoralSetupError,
  type SetupErrorAuthorIdentity,
} from '#src/runtime/errors.js';
import { statusFromStartupDiagnostic } from '#src/transport/http/backend/status.js';

const SELF_IDENTITY: SetupErrorAuthorIdentity = { bundleHash: '0123456789abcdef', namespace: 'self-namespace' };
const OTHER_IDENTITY: SetupErrorAuthorIdentity = { bundleHash: 'fedcba9876543210', namespace: 'other-namespace' };

const THIS_BUILD = resolveSetupErrorAuthorship({ recorded: SELF_IDENTITY, self: SELF_IDENTITY });
const OTHER_BUILD = resolveSetupErrorAuthorship({ recorded: OTHER_IDENTITY, self: SELF_IDENTITY });
const UNPROVABLE = resolveSetupErrorAuthorship({ recorded: SELF_IDENTITY, self: null });

/** A documented code renders from the catalog whoever wrote the record, so these cases fix authorship. */
function readAsThisBuild(error: unknown): OperatorFacingCoralSetupError {
  return readOperatorFacingCoralSetupError(error, THIS_BUILD);
}

type HandoffRefusalCase = Readonly<{
  init: HandoffRefusalInit;
  userMessage: string;
  remediation: string;
  exitCode: number;
  observation: 'not_observed' | undefined;
  retryable: boolean;
}>;

const HANDOFF_REFUSAL_CASES = [
  {
    init: {
      code: 'handoff_fresh_discovery_unavailable',
      context: { stage: 'after-sigterm-grace', pid: 4242, signal: 'SIGTERM', graceMs: 15_000 },
    },
    userMessage:
      'Handoff refused after accepted SIGTERM for incumbent pid=4242 and its 15000ms grace elapsed: fresh coordinator discovery was unavailable.',
    remediation: 'Retry when verified discovery is available.',
    exitCode: 75,
    observation: 'not_observed',
    retryable: true,
  },
  {
    init: { code: 'handoff_fresh_discovery_changed', context: { stage: 'before-signal', pid: 4242 } },
    userMessage: 'Handoff refused before signaling incumbent pid=4242: fresh coordinator discovery changed.',
    remediation: 'Retry handoff against the newly discovered incumbent.',
    exitCode: 75,
    observation: undefined,
    retryable: true,
  },
  {
    init: {
      code: 'handoff_signal_capability_unavailable',
      context: {
        stage: 'after-sigterm-grace',
        pid: 4242,
        signal: 'SIGTERM',
        graceMs: 15_000,
        missingFields: ['instanceId', 'bootToken'],
      },
    },
    userMessage:
      'Handoff refused after accepted SIGTERM for incumbent pid=4242 and its 15000ms grace elapsed: verified discovery lacks required signal-capability fields (instanceId, bootToken).',
    remediation:
      'Repair or replace the coordinator discovery record, or stop the target through its host service, then retry handoff.',
    exitCode: 77,
    observation: undefined,
    retryable: false,
  },
  {
    init: {
      code: 'handoff_signal_cooldown_active',
      context: {
        stage: 'before-signal',
        pid: 4242,
        requestedSignal: 'SIGKILL',
        previousSignal: 'SIGTERM',
        ageMs: 1_000,
        retryInMs: 59_000,
      },
    },
    userMessage:
      'Handoff refused before repeated SIGKILL for incumbent pid=4242: the previous SIGTERM was 1000ms ago; retry in 59000ms.',
    remediation: 'Wait 59000ms for the handoff signal cooldown to elapse, then retry handoff.',
    exitCode: 75,
    observation: undefined,
    retryable: true,
  },
  {
    init: {
      code: 'handoff_legacy_signal_attempt_indeterminate',
      context: {
        stage: 'before-signal',
        pid: 4242,
        requestedSignal: 'SIGKILL',
        previousSignal: 'SIGTERM',
        ageMs: 1_000,
        retryInMs: 59_000,
      },
    },
    userMessage:
      'Handoff refused before SIGKILL for incumbent pid=4242: the legacy record proves only that SIGTERM was attempted 1000ms ago, not that it was accepted; retry in 59000ms.',
    remediation:
      'Inspect the identified target and wait 59000ms for the legacy attempt cooldown to elapse, then retry handoff.',
    exitCode: 75,
    observation: 'not_observed',
    retryable: true,
  },
  {
    init: { code: 'handoff_shutdown_capability_rejected', context: { stage: 'shutdown-request', pid: 'unknown' } },
    userMessage:
      'Handoff refused during the shutdown request for incumbent pid=unknown: the incumbent rejected the shutdown capability.',
    remediation:
      'Stop the incumbent that owns the coordinator socket through the service or account that owns it, then retry handoff.',
    exitCode: 77,
    observation: undefined,
    retryable: false,
  },
  {
    init: { code: 'handoff_shutdown_credential_unavailable', context: { stage: 'shutdown-request', pid: 4242 } },
    userMessage:
      'Handoff refused during the shutdown request for incumbent pid=4242: verified discovery had no boot credential for shutdown.',
    remediation: 'Stop the identified incumbent through the service or account that owns it, then retry handoff.',
    exitCode: 77,
    observation: undefined,
    retryable: false,
  },
  {
    init: {
      code: 'handoff_socket_holder_unverified',
      context: { stage: 'handoff-deadline', socketPath: '/run/coral/coordinator.sock' },
    },
    userMessage:
      'Handoff refused at the startup deadline for socket /run/coral/coordinator.sock: the socket remained bound but no verified holder pid was available.',
    remediation:
      'Inspect and recover the process or stale socket that holds the coordinator socket, then retry handoff.',
    exitCode: 75,
    observation: 'not_observed',
    retryable: false,
  },
  {
    init: { code: 'handoff_manual_policy', context: { stage: 'before-signal', pid: 4242, policy: 'manual' } },
    userMessage:
      'Handoff refused before signaling incumbent pid=4242: CORAL_HANDOFF_SIGNAL_POLICY=manual forbids automated handoff signals.',
    remediation:
      'Stop the target through the service or account that owns it, then retry handoff; or deliberately change CORAL_HANDOFF_SIGNAL_POLICY and retry.',
    exitCode: 77,
    observation: undefined,
    retryable: false,
  },
  {
    init: {
      code: 'handoff_term_only_policy',
      context: { stage: 'after-sigterm-grace', pid: 4242, graceMs: 15_000, policy: 'term-only' },
    },
    userMessage:
      'Handoff refused after accepted SIGTERM for incumbent pid=4242 and its 15000ms grace elapsed: CORAL_HANDOFF_SIGNAL_POLICY=term-only forbids SIGKILL.',
    remediation:
      "Wait for the target's own shutdown to finish or stop it through the service or account that owns it, then retry handoff; or deliberately change CORAL_HANDOFF_SIGNAL_POLICY and retry.",
    exitCode: 77,
    observation: undefined,
    retryable: true,
  },
  {
    init: {
      code: 'handoff_process_identity_unavailable',
      context: { stage: 'after-accepted-signal-failure', pid: 4242, signal: 'SIGTERM' },
    },
    userMessage:
      'Handoff failed after accepted SIGTERM for incumbent pid=4242: the process incarnation was unavailable and pid absence was not established.',
    remediation:
      'Retry when a fresh process-identity observation for this pid succeeds; if it remains unavailable, inspect and stop the target through its host service before retrying handoff.',
    exitCode: 75,
    observation: 'not_observed',
    retryable: true,
  },
  {
    init: {
      code: 'handoff_process_liveness_unknown',
      context: { stage: 'after-accepted-signal-failure', pid: 4242, signal: 'SIGKILL' },
    },
    userMessage:
      'Handoff failed after accepted SIGKILL for incumbent pid=4242: the target identity matched but its current liveness could not be observed.',
    remediation:
      'Retry when a process-liveness observation for this pid succeeds; if it remains unavailable, inspect and stop the target through its host service before retrying handoff.',
    exitCode: 75,
    observation: 'not_observed',
    retryable: true,
  },
  {
    init: { code: 'handoff_platform_identity_insufficient', context: { stage: 'before-signal', pid: 4242 } },
    userMessage:
      'Handoff refused before signaling incumbent pid=4242: this platform cannot produce a process identity strong enough to authorize a signal.',
    remediation: 'Stop the Coral backend through its service or socket, not by pid, then retry handoff.',
    exitCode: 77,
    observation: undefined,
    retryable: false,
  },
  {
    init: { code: 'handoff_published_incarnation_missing', context: { stage: 'before-signal', pid: 4242 } },
    userMessage:
      'Handoff refused before signaling incumbent pid=4242: the incumbent published no incarnation, so this pid cannot be proven to be it.',
    remediation: 'Stop the Coral backend through its service or socket, not by this pid, then retry handoff.',
    exitCode: 77,
    observation: undefined,
    retryable: false,
  },
  {
    init: {
      code: 'handoff_published_incarnation_mismatch',
      context: { stage: 'after-sigterm-grace', pid: 4242, signal: 'SIGTERM', graceMs: 15_000 },
    },
    userMessage:
      'Handoff refused after accepted SIGTERM for incumbent pid=4242 and its 15000ms grace elapsed: this pid is not the process the incumbent published.',
    remediation:
      'Retry handoff against a freshly discovered incumbent; if the mismatch persists, stop the target through its host service before retrying handoff.',
    exitCode: 75,
    observation: undefined,
    retryable: true,
  },
  {
    init: { code: 'handoff_signal_anchor_missing', context: { stage: 'before-signal', pid: 4242 } },
    userMessage:
      'Handoff refused before signaling incumbent pid=4242: no baseline was observed for this pid while it was authenticated.',
    remediation:
      'Retry handoff so a new attempt can establish an authenticated baseline; if it cannot, stop the target through its host service before retrying handoff.',
    exitCode: 75,
    observation: 'not_observed',
    retryable: true,
  },
  {
    init: {
      code: 'handoff_pid_recycled',
      context: { stage: 'after-accepted-signal-bind', pid: 4242, signal: 'SIGTERM' },
    },
    userMessage:
      'Handoff refused after the socket became bindable following accepted SIGTERM for incumbent pid=4242: the pid was recycled after this coordinator observed it.',
    remediation:
      'Retry handoff against the current incumbent; if ownership remains unclear, stop it through its host service before retrying handoff.',
    exitCode: 75,
    observation: undefined,
    retryable: true,
  },
  {
    init: {
      code: 'handoff_signal_rejected_live',
      context: { stage: 'after-rejected-signal', pid: 4242, signal: 'SIGTERM' },
    },
    userMessage:
      'Handoff refused after SIGTERM was rejected for incumbent pid=4242: the verified target remained alive; this process may lack permission or the target may be outside its signal reach.',
    remediation: 'Stop the target through the service or account that owns it, then retry handoff.',
    exitCode: 77,
    observation: undefined,
    retryable: false,
  },
  {
    init: {
      code: 'handoff_accepted_signal_target_alive_after_failure',
      context: { stage: 'after-accepted-signal-failure', pid: 4242, signal: 'SIGTERM' },
    },
    userMessage:
      'Handoff failed after accepted SIGTERM for incumbent pid=4242: the target was not observed gone before another handoff operation failed.',
    remediation:
      'Wait for the identified target to finish shutting down or stop it through the service or account that owns it, then retry startup.',
    exitCode: 69,
    observation: undefined,
    retryable: true,
  },
  {
    init: {
      code: 'handoff_accepted_signal_target_alive_after_bind',
      context: { stage: 'after-accepted-signal-bind', pid: 4242, signal: 'SIGKILL' },
    },
    userMessage:
      'Handoff refused after the socket became bindable following accepted SIGKILL for incumbent pid=4242: the verified target remained alive.',
    remediation:
      'Wait for the identified target to finish shutting down or stop it through the service or account that owns it, then retry startup.',
    exitCode: 69,
    observation: undefined,
    retryable: true,
  },
  {
    init: {
      code: 'handoff_sigkill_grace_target_gone_socket_still_bound',
      context: { stage: 'after-sigkill-grace', pid: 4242, signal: 'SIGKILL', graceMs: 5_000 },
    },
    userMessage:
      'Handoff refused after accepted SIGKILL for incumbent pid=4242 and its 5000ms grace elapsed: the target is gone, but the coordinator socket remained bound.',
    remediation:
      'Retry the original coral-cli mutating command so Coral re-observes ownership and removes the socket only if it proves stale.',
    exitCode: 75,
    observation: undefined,
    retryable: true,
  },
  {
    init: {
      code: 'handoff_sigkill_grace_target_alive',
      context: { stage: 'after-sigkill-grace', pid: 4242, signal: 'SIGKILL', graceMs: 5_000 },
    },
    userMessage:
      'Handoff refused after accepted SIGKILL for incumbent pid=4242 and its 5000ms grace elapsed: the verified target remained alive.',
    remediation:
      'Wait for uninterruptible I/O to finish or stop pid=4242 through its host service, then retry startup.',
    exitCode: 69,
    observation: undefined,
    retryable: true,
  },
] satisfies readonly HandoffRefusalCase[];

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
  it('keeps the prefix-derived handoff codes and context keys mutually exhaustive', () => {
    expectTypeOf<Exclude<HandoffRefusalCode, keyof HandoffRefusalContextByCode>>().toEqualTypeOf<never>();
    expectTypeOf<Exclude<keyof HandoffRefusalContextByCode, HandoffRefusalCode>>().toEqualTypeOf<never>();
    expectTypeOf<AssertHandoffRefusalContextCoversCodes>().toEqualTypeOf<never>();
    expectTypeOf<AssertHandoffRefusalCodesCoverContext>().toEqualTypeOf<never>();
  });

  it.each(HANDOFF_REFUSAL_CASES)(
    'pins the documented handoff catalog row for $init.code',
    ({ init, userMessage, remediation, exitCode, observation, retryable }) => {
      const error = documentedCoralSetupError(init.code, init.context);

      expect(error).toMatchObject({ code: init.code, userMessage, remediation, context: init.context });
      expect(error.message).toBe(userMessage);
      expect(documentedCoralSetupErrorExitCode(init.code)).toBe(exitCode);
      expect(NOT_OBSERVED_CORAL_SETUP_ERROR_CODES.has(init.code)).toBe(observation === 'not_observed');
      expect(isRetryableCoralSetupError(error)).toBe(retryable);
    },
  );

  it.each(HANDOFF_REFUSAL_CASES)(
    'restores validated persisted context for $init.code without trusting persisted prose',
    ({ init, userMessage, remediation }) => {
      expect(
        readAsThisBuild({
          code: init.code,
          userMessage: 'persisted user message',
          remediation: 'persisted remediation',
          context: init.context,
        }),
      ).toEqual({ kind: 'documented', code: init.code, userMessage, remediation });
    },
  );

  it('distinguishes retryability after accepted SIGTERM from a manual pre-signal refusal', () => {
    const retryability = Object.fromEntries(
      HANDOFF_REFUSAL_CASES.filter(({ init }) =>
        ['handoff_term_only_policy', 'handoff_manual_policy'].includes(init.code),
      ).map(({ init, retryable }) => [init.code, retryable]),
    );

    expect(retryability).toEqual({ handoff_manual_policy: false, handoff_term_only_policy: true });
  });

  // A coordinator-side refusal reaches `startup-diagnostic.json`, and `backend status` re-renders its
  // remediation from this registry, so no documented remediation may promise that a command relaunches the
  // backend: `backend status` never observed that one is absent, and the command it names attempts startup
  // or handoff without guaranteeing either.
  it('authors no documented remediation that promises a relaunch', () => {
    // A handoff code's remediation is a function of a context it requires, so its own case supplies one.
    const handoffRemediations = new Map<string, string>(
      HANDOFF_REFUSAL_CASES.map(({ init }) => [init.code, renderHandoffRefusal(init).remediation]),
    );

    // Checked before the sweep: a handoff code with no case would otherwise reach the context-free render
    // below and throw, instead of reporting that its remediation was never checked.
    expect(DOCUMENTED_CORAL_SETUP_ERROR_CODES.filter((code) => code.startsWith('handoff_')).sort()).toEqual(
      [...handoffRemediations.keys()].sort(),
    );
    expect(DOCUMENTED_CORAL_SETUP_ERROR_CODES).toContain('coordinator_record_unreadable');
    expect(
      DOCUMENTED_CORAL_SETUP_ERROR_CODES.filter((code) =>
        /\brelaunch(?:es|ing)?\b/iu.test(handoffRemediations.get(code) ?? documentedCoralSetupError(code).remediation),
      ),
    ).toEqual([]);
  });

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

  it('replaces persisted setup-error text with the documented template before operator display', () => {
    const context = { version: '0.11.0', flavor: 'prod' };
    const documented = documentedCoralSetupError('store_newer_incompatible', context);

    expect(
      readAsThisBuild({
        code: 'store_newer_incompatible',
        userMessage: '\u001b[2J\nNext step: run a forged command',
        remediation: 'forged remediation',
        context,
      }),
    ).toEqual({
      kind: 'documented',
      code: documented.code,
      userMessage: documented.userMessage,
      remediation: documented.remediation,
    });
  });

  it('returns an explicit unrecognized disposition for a foreign code outside the catalog', () => {
    expect(
      readOperatorFacingCoralSetupError(
        {
          code: 'future_setup_refusal',
          userMessage: 'future text',
          remediation: 'future remediation',
        },
        OTHER_BUILD,
      ),
    ).toEqual({ kind: 'unrecognized_code', code: 'future_setup_refusal', authorship: 'other-build' });
  });

  // Everything this build throws that the catalog does not name reaches an operator through this arm; the
  // catalog was assumed complete twice and was not, and completing it is not a property anything can check.
  it('carries the recorded text of an uncatalogued code this build proves it wrote', () => {
    expect(
      readAsThisBuild({
        code: 'describer_missing',
        userMessage: 'Event describer missing for: job_started, session_forked.',
        remediation: "Add an entry to the owning domain's event-describers.ts.",
      }),
    ).toEqual({
      kind: 'self_authored',
      code: 'describer_missing',
      userMessage: 'Event describer missing for: job_started, session_forked.',
      remediation: "Add an entry to the owning domain's event-describers.ts.",
    });
  });

  it('refuses the recorded text of an uncatalogued code when authorship is unprovable', () => {
    expect(
      readOperatorFacingCoralSetupError(
        {
          code: 'describer_missing',
          userMessage: 'unproven text',
          remediation: 'unproven remediation',
        },
        UNPROVABLE,
      ),
    ).toEqual({ kind: 'unrecognized_code', code: 'describer_missing', authorship: 'unprovable' });
  });

  it.each([
    ['a terminal escape', '\u001b[2J\nNext step: run a forged command'],
    ['a bare line break', 'Event describer missing.\nNext step: run a forged command'],
    ['an unbounded span', 'x'.repeat(1_025)],
    ['nothing at all', '   '],
  ])('refuses recorded text this build wrote when it carries %s', (_name, userMessage) => {
    expect(readAsThisBuild({ code: 'describer_missing', userMessage, remediation: 'authored remediation' })).toEqual({
      kind: 'unrecognized_code',
      code: 'describer_missing',
      authorship: 'this-build',
    });
  });

  it('refuses recorded text this build wrote when only its remediation is unsafe', () => {
    expect(
      readAsThisBuild({
        code: 'describer_missing',
        userMessage: 'Event describer missing for: job_started.',
        remediation: '\u001b[2Jforged remediation',
      }),
    ).toEqual({ kind: 'unrecognized_code', code: 'describer_missing', authorship: 'this-build' });
  });

  it('trims recorded text rather than rejecting it for surrounding space', () => {
    expect(
      readAsThisBuild({
        code: 'describer_missing',
        userMessage: '  Event describer missing for: job_started.  ',
        remediation: ' Add an entry. ',
      }),
    ).toEqual({
      kind: 'self_authored',
      code: 'describer_missing',
      userMessage: 'Event describer missing for: job_started.',
      remediation: 'Add an entry.',
    });
  });

  it.each([
    { name: 'a matching identity', recorded: SELF_IDENTITY, self: SELF_IDENTITY, expected: 'this-build' },
    { name: 'a differing identity', recorded: OTHER_IDENTITY, self: SELF_IDENTITY, expected: 'other-build' },
    { name: 'no recorded identity', recorded: null, self: SELF_IDENTITY, expected: 'unprovable' },
    { name: 'no proven self identity', recorded: SELF_IDENTITY, self: null, expected: 'unprovable' },
    {
      name: 'an empty recorded bundle hash',
      recorded: { bundleHash: '', namespace: 'self-namespace' },
      self: { bundleHash: '', namespace: 'self-namespace' },
      expected: 'unprovable',
    },
    {
      name: 'a blank recorded namespace',
      recorded: { bundleHash: '0123456789abcdef', namespace: '   ' },
      self: { bundleHash: '0123456789abcdef', namespace: '   ' },
      expected: 'unprovable',
    },
  ])('resolves authorship from $name', ({ recorded, self, expected }) => {
    expect(resolveSetupErrorAuthorship({ recorded, self }).kind).toBe(expected);
  });

  it.each([
    undefined,
    '',
    'future setup refusal',
    'Future_setup_refusal',
    'future__setup_refusal',
    'future_setup_refusal\nnext_step',
    'x'.repeat(129),
  ])('returns an invalid disposition for non-canonical setup-error code %j', (code) => {
    expect(readAsThisBuild({ code, userMessage: 'persisted text' })).toEqual({
      kind: 'invalid_diagnostic',
    });
  });

  it.each(['0.11.0\nNext step: forged', 'x'.repeat(513)])(
    'falls back when persisted context text is unsafe or unbounded',
    (version) => {
      expect(
        readAsThisBuild({
          code: 'store_newer_incompatible',
          userMessage: 'persisted user message',
          remediation: 'persisted remediation',
          context: { version, flavor: 'prod' },
        }),
      ).toEqual({
        kind: 'documented',
        code: 'store_newer_incompatible',
        userMessage:
          'The current-generation store was written by newer Coral <stored-version> and is incompatible with this build.',
        remediation:
          "Use Coral <stored-version> to read this store, or run 'coral-cli backend store-reset discard --target gen2 --flavor prod' to quarantine it before this build initializes an empty store.",
      });
    },
  );

  it('renders a missing context value with the placeholder its own template names', () => {
    // The template that reads `socketPath` owns the word shown when a diagnostic did not carry it.
    const documented = documentedCoralSetupError('coordinator_socket_bind_failed');
    const restored = readAsThisBuild({
      code: 'coordinator_socket_bind_failed',
      userMessage: 'persisted user message',
      remediation: 'persisted remediation',
    });

    expect(restored).toEqual({
      kind: 'documented',
      code: 'coordinator_socket_bind_failed',
      userMessage: documented.userMessage,
      remediation: documented.remediation,
    });
    expect(documented.userMessage).toContain('<socket-path>');
  });

  it('keeps a cooldown refusal documented when a backwards clock step makes the age negative', () => {
    const context = {
      stage: 'before-signal',
      pid: 4242,
      requestedSignal: 'SIGKILL',
      previousSignal: 'SIGTERM',
      ageMs: -9_000,
      retryInMs: 69_000,
    } as const;
    const documented = documentedCoralSetupError('handoff_signal_cooldown_active', context);

    expect(
      readAsThisBuild({
        code: 'handoff_signal_cooldown_active',
        userMessage: 'persisted user message',
        remediation: 'persisted remediation',
        context,
      }),
    ).toEqual({
      kind: 'documented',
      code: 'handoff_signal_cooldown_active',
      userMessage: documented.userMessage,
      remediation: documented.remediation,
    });
    expect(documented.userMessage).toContain('-9000ms ago');
  });

  it('still drops a negative value on a context key that measures no elapsed span', () => {
    expect(
      readAsThisBuild({
        code: 'handoff_sigkill_grace_target_alive',
        userMessage: 'persisted user message',
        remediation: 'persisted remediation',
        context: { stage: 'after-sigkill-grace', pid: 4242, signal: 'SIGKILL', graceMs: -15_000 },
      }),
    ).toEqual({
      kind: 'unrenderable_context',
      code: 'handoff_sigkill_grace_target_alive',
      authorship: 'this-build',
    });
  });

  it('restores a handoff socket-holder refusal for a non-ASCII canonical path', () => {
    const socketPath = '/home/김/.coral/run/coordinator.sock';

    expect(
      readAsThisBuild({
        code: 'handoff_socket_holder_unverified',
        userMessage: 'persisted user message',
        remediation: 'persisted remediation',
        context: { stage: 'handoff-deadline', socketPath },
      }),
    ).toEqual({
      kind: 'documented',
      code: 'handoff_socket_holder_unverified',
      userMessage: `Handoff refused at the startup deadline for socket ${socketPath}: the socket remained bound but no verified holder pid was available.`,
      remediation:
        'Inspect and recover the process or stale socket that holds the coordinator socket, then retry handoff.',
    });
  });

  it.each([
    {
      field: 'pluginRoot',
      code: 'startup_bundle_unresolvable' as const,
      context: { pluginRoot: '/home/김/플러그인' },
      expected: '/home/김/플러그인',
    },
    {
      field: 'socketPath',
      code: 'coordinator_socket_bind_failed' as const,
      context: { socketPath: '/home/김/run/coordinator.sock' },
      expected: '/home/김/run/coordinator.sock',
    },
    {
      field: 'directory',
      code: 'coordinator_socket_dir_insecure' as const,
      context: { directory: '/tmp/사용자', reason: 'unusable' },
      expected: '/tmp/사용자',
    },
    {
      field: 'legacyPath',
      code: 'legacy_foreign_generation' as const,
      context: { operation: 'discard', legacyPath: '/home/김/legacy' },
      expected: '/home/김/legacy',
    },
    {
      field: 'baseDir',
      code: 'legacy_foreign_generation' as const,
      context: { operation: 'discard', legacyPath: '/legacy', baseDir: '/home/김/state' },
      expected: '/home/김/state',
    },
    {
      field: 'path',
      code: 'store_open_contended' as const,
      context: { path: '/home/김/store.db' },
      expected: '/home/김/store.db',
    },
    {
      field: 'quarantineDir',
      code: 'kb_commit_already_quarantined' as const,
      context: { quarantineDir: '/home/김/quarantine' },
      expected: '/home/김/quarantine',
    },
    {
      field: 'recordPath',
      code: 'active_store_coordination_invalid' as const,
      context: { recordPath: '/home/김/record', failureCode: 'record_changed' },
      expected: '/home/김/record',
    },
    {
      field: 'coordinationRoot',
      code: 'active_store_coordination_invalid' as const,
      context: { coordinationRoot: '/home/김/coordination', failureCode: 'coordination_directory_mode' },
      expected: '/home/김/coordination',
    },
  ])('preserves non-ASCII filesystem field $field', ({ code, context, expected }) => {
    const result = readAsThisBuild({
      code,
      userMessage: 'persisted user message',
      remediation: 'persisted remediation',
      context,
    });

    expect(result.kind).toBe('documented');
    if (result.kind === 'documented') expect(`${result.userMessage}\n${result.remediation}`).toContain(expected);
  });

  it('rejects noncanonical and terminal-unsafe filesystem context values', () => {
    for (const socketPath of [
      'relative/coordinator.sock',
      '/home/user/../other/coordinator.sock',
      '/home/김/.coral/run/coordinator.sock\nNext step: forged',
      '/home/김/.coral/run/\u001b[2Jcoordinator.sock',
      '/home/김/.coral/run/\u202ecoordinator.sock',
    ]) {
      expect(
        readAsThisBuild({
          code: 'handoff_socket_holder_unverified',
          userMessage: 'persisted user message',
          remediation: 'persisted remediation',
          context: { stage: 'handoff-deadline', socketPath },
        }),
      ).toEqual({
        kind: 'unrenderable_context',
        code: 'handoff_socket_holder_unverified',
        authorship: 'this-build',
      });
    }
  });

  // The rollback shape: a later build adds a field to this code's context and hands startup to this one, whose
  // exact-key validator rejects the whole record. Declining to render text written by a build this one cannot
  // vouch for is right; declining to say which refusal happened leaves the operator nothing to search for.
  it('names a documented code whose recorded context carries a field this build does not know', () => {
    expect(
      readOperatorFacingCoralSetupError(
        {
          code: 'handoff_socket_holder_unverified',
          userMessage: 'later-build text',
          remediation: 'Run a later-build command.',
          context: {
            stage: 'handoff-deadline',
            socketPath: '/run/coral/coordinator.sock',
            holderProbe: 'unsupported',
          },
        },
        OTHER_BUILD,
      ),
    ).toEqual({
      kind: 'unrenderable_context',
      code: 'handoff_socket_holder_unverified',
      authorship: 'other-build',
    });
  });

  // Every Node errno message quotes the path it names, and this remediation branches on reading one.
  it.each([
    {
      observation: 'an errno message',
      cause: "EACCES: permission denied, lstat '/tmp/coral-8f21'",
      remediation:
        'Resolve the filesystem error reported in the observation above, then start Coral again. Coral will not bind its singleton socket in a directory it could not observe.',
    },
    {
      observation: 'an owner the filesystem would not name',
      cause: "its parent '/tmp' reported no owner",
      remediation:
        'Start Coral on a filesystem that reports owner identity for the fallback directory. The observation succeeded but did not identify an owner, so Coral could not settle whether the directory is private.',
    },
  ])('keeps $observation in the operator text of a documented non-handoff refusal', ({ cause, remediation }) => {
    const context = { reason: 'unverified', directory: '/tmp/coral-8f21', uid: 1000, cause };

    expect(
      readAsThisBuild({
        code: 'coordinator_socket_dir_unverified',
        userMessage: 'persisted user message',
        remediation: 'persisted remediation',
        context,
      }),
    ).toEqual({
      kind: 'documented',
      code: 'coordinator_socket_dir_unverified',
      userMessage: documentedCoralSetupError('coordinator_socket_dir_unverified', context).userMessage,
      remediation,
    });
  });

  it('still drops an open-text context value the rendering surfaces cannot carry', () => {
    for (const cause of [
      "EACCES: permission denied, lstat '/tmp/coral-8f21'\nNext step: run a forged command",
      "\u001b[2JEACCES: permission denied, lstat '/tmp/coral-8f21'",
      "EACCES: permission denied, lstat '/tmp/\u202ecoral-8f21'",
    ]) {
      const restored = readAsThisBuild({
        code: 'coordinator_socket_dir_unverified',
        userMessage: 'persisted user message',
        remediation: 'persisted remediation',
        context: { reason: 'unverified', directory: '/tmp/coral-8f21', uid: 1000, cause },
      });

      expect(restored).toEqual({
        kind: 'documented',
        code: 'coordinator_socket_dir_unverified',
        userMessage:
          "Coral's coordinator socket uses /tmp/coral-8f21, but Coral could not establish whether that directory is private to you (cause unavailable). This does not mean the directory is wrong.",
        remediation:
          'Resolve the filesystem error reported in the observation above, then start Coral again. Coral will not bind its singleton socket in a directory it could not observe.',
      });
    }
  });

  // A code this build documents may not come out of the reader anonymous. The code is the operator's only
  // handle on the refusal — the one token that finds it in a log or a release note — and refusing to render
  // an untrusted context is no reason to withhold it, which would leave a known code with less to act on than
  // an unknown one.
  it.each([
    {
      failure: 'a discriminator owned by another refusal',
      code: 'handoff_fresh_discovery_unavailable',
      context: { stage: 'shutdown-request', pid: 4242 },
    },
    {
      failure: 'a missing required field',
      code: 'handoff_shutdown_credential_unavailable',
      context: { stage: 'shutdown-request' },
    },
  ])('still names the code when backend status reads a known refusal with $failure', ({ code, context }) => {
    const now = Date.parse('2026-09-01T00:00:00.000Z');

    expect(
      statusFromStartupDiagnostic(
        {
          schemaVersion: 1,
          state: 'stopped_with_diagnostic',
          retryable: true,
          phase: 'startup_failed',
          recordedAt: new Date(now).toISOString(),
          error: {
            kind: 'coral_setup_error',
            code,
            userMessage: 'persisted user message',
            remediation: 'persisted remediation',
            context,
          },
        },
        now,
        () => SELF_IDENTITY,
      ),
    ).toEqual({
      status: 'recent_failure',
      phase: 'startup_failed',
      retryable: true,
      // The diagnostic carries no author identity, so authorship is `unprovable` — not a weaker `other-build`.
      setupError: { kind: 'unrenderable_context', code, authorship: 'unprovable' },
    });
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
      'system_provider_scope_invalid',
      { scopeName: 'internal' },
      "Named system provider scope 'internal' is invalid.",
      'Edit CORAL_SYSTEM_PROVIDER_SCOPE, remove the duplicate or invalid provider entry, and restart Coral.',
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
      'legacy_source_writer_observation_unknown',
      {
        operation: 'store-reset',
        holder: 'routing-status:handoff-routing-status (pid 42), process identity unobservable',
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
      'recovery_quarantine_subject_not_found',
      {},
      'That recovery quarantine key does not name a retained row.',
      'Run `coral-cli backend recovery-quarantine list`, copy one row’s current boundary, key, and revision, then retry clear with that exact coordinate.',
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
      "Set GEMINI_API_KEY in the backend's environment (e.g. the `env` block of ~/.claude/settings.json), run 'coral-cli backend shutdown', then rerun `coral-cli expansion equip gemini`; it attempts startup or handoff with that environment.",
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
        cause: 'the required socket-directory owner uid is not usable',
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
        'Start Coral in an environment that provides an owner uid the filesystem can represent for the fallback directory. Coral will not bind its singleton socket without a usable owner identity.',
      );
      expect(missingOwner.remediation).toBe(
        'Start Coral on a filesystem that reports owner identity for the fallback directory. The observation succeeded but did not identify an owner, so Coral could not settle whether the directory is private.',
      );
      expect(missingOwner.remediation).not.toContain('error');
    });
  });
});
