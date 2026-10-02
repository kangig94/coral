import { describe, it, expect } from 'vitest';
import {
  readOperatorFacingCoralSetupError,
  resolveSetupErrorAuthorship,
  type OperatorFacingCoralSetupError,
  type SetupErrorAuthorIdentity,
} from '#src/runtime/errors.js';

const SELF_IDENTITY: SetupErrorAuthorIdentity = { bundleHash: '0123456789abcdef', namespace: 'self-namespace' };
const OTHER_IDENTITY: SetupErrorAuthorIdentity = { bundleHash: 'fedcba9876543210', namespace: 'other-namespace' };

const THIS_BUILD = resolveSetupErrorAuthorship({ recorded: SELF_IDENTITY, self: SELF_IDENTITY });
const OTHER_BUILD = resolveSetupErrorAuthorship({ recorded: OTHER_IDENTITY, self: SELF_IDENTITY });
const UNPROVABLE = resolveSetupErrorAuthorship({ recorded: SELF_IDENTITY, self: null });

/** A documented code renders from the catalog whoever wrote the record, so these cases fix authorship. */
function readAsThisBuild(error: unknown): OperatorFacingCoralSetupError {
  return readOperatorFacingCoralSetupError(error, THIS_BUILD);
}

describe('CoralSetupError', () => {
  it('restores documented context without trusting persisted prose', () => {
    const result = readAsThisBuild({
      code: 'handoff_shutdown_credential_unavailable',
      userMessage: 'persisted user message',
      remediation: 'persisted remediation',
      context: { stage: 'shutdown-request', pid: 4242 },
    });

    expect(result).toMatchObject({
      kind: 'documented',
      code: 'handoff_shutdown_credential_unavailable',
      userMessage: expect.stringContaining('4242'),
    });
    if (result.kind !== 'documented') throw new Error('Expected documented setup error');
    expect(result.userMessage).not.toBe('persisted user message');
    expect(result.remediation).not.toBe('persisted remediation');
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

      expect(restored).toMatchObject({
        kind: 'documented',
        code: 'coordinator_socket_dir_unverified',
      });
      if (restored.kind !== 'documented') throw new Error('Expected documented setup error');
      expect(restored.userMessage).toContain('cause unavailable');
      expect(restored.userMessage).not.toContain(cause);
    }
  });
});
