import { describe, expect, it, vi } from 'vitest';

import type { ProviderJobLaunch } from '#src/jobs/records.js';
import type { ProviderSession } from '#src/sessions/entry.js';
import {
  materializeProviderOperationPrepare,
  providerOperationPrepareMaterializationResultSchema,
  type ProviderOperationPrepareMaterializerDeps,
} from '#src/coordinator/services/provider-operation-prepare.js';
import type { ProviderOperationPrepareSource } from '#src/store/provider-operation-record.js';

import { providerOperationRecord } from '../../store/provider-operation-fixtures.js';

const canonicalProjectRoot = process.cwd();

describe('materializeProviderOperationPrepare', () => {
  it('derives its strict materialization outcomes from the complete canonical refusal shape', () => {
    const prepared = {
      version: 1,
      provider: 'codex',
      binding: { provider: 'codex', kind: 'account', binding: { account: 'acct-1' } },
      request: {
        action: 'exec',
        sessionId: 'session-1',
        prompt: 'do the thing',
        cwd: '/workspace',
        bypassPermissions: false,
        coralEnv: {},
      },
      persistedContinuity: null,
      baseEnv: { PATH: '/usr/bin' },
      protectedEnv: {},
      platform: 'linux',
    };
    const refusal = {
      state: 'permanent-refusal',
      code: 'authorization_expired',
      disposition: 'terminal-failure',
      reason: 'Provider operation child authorization has expired.',
    };

    expect(providerOperationPrepareMaterializationResultSchema.safeParse({ state: 'prepared', prepared }).success).toBe(
      true,
    );
    expect(providerOperationPrepareMaterializationResultSchema.safeParse(refusal).success).toBe(true);
    for (const code of [
      'authorization_expired',
      'prepare_materialization_refused',
      'provider_reconstruction_refused',
      'provider_creation_refused',
      'proxy_prepare_refused',
    ] as const) {
      expect(providerOperationPrepareMaterializationResultSchema.safeParse({ ...refusal, code }).success).toBe(true);
    }
    expect(
      providerOperationPrepareMaterializationResultSchema.safeParse({
        ...refusal,
        disposition: 'local-fallback',
      }).success,
    ).toBe(true);
    expect(
      providerOperationPrepareMaterializationResultSchema.safeParse({ ...refusal, unexpected: true }).success,
    ).toBe(false);
    expect(
      providerOperationPrepareMaterializationResultSchema.safeParse({ ...refusal, code: 'retry_later' }).success,
    ).toBe(false);
    expect(
      providerOperationPrepareMaterializationResultSchema.safeParse({
        state: 'permanent-refusal',
        code: 'authorization_expired',
        disposition: 'terminal-failure',
      }).success,
    ).toBe(false);
    expect(providerOperationPrepareMaterializationResultSchema.safeParse({ ...refusal, reason: '' }).success).toBe(
      false,
    );
    expect(
      providerOperationPrepareMaterializationResultSchema.safeParse({ ...refusal, reason: 'x'.repeat(4097) }).success,
    ).toBe(false);
    expect(providerOperationPrepareMaterializationResultSchema.safeParse({ kind: 'prepared', prepared }).success).toBe(
      false,
    );
  });

  it('refuses an expired child authorization before reminting a bearer handle', () => {
    const record = providerOperationRecord('prepare-pending');
    if (record.phase !== 'prepare-pending') throw new Error('expected prepare-pending fixture');
    const source: ProviderOperationPrepareSource = {
      ...record.prepareSource,
      childAuthorization: { ...record.prepareSource.childAuthorization, expiresAtMs: 100 },
    };
    const launch: ProviderJobLaunch = {
      jobId: record.operation.jobId,
      owner: { kind: 'provider-session', id: source.sessionId },
      sessionId: source.sessionId,
      provider: 'codex',
      projectRoot: canonicalProjectRoot,
      backendNamespace: source.childAuthorization.namespace,
      pool: 'default',
      enqueueSequence: 1,
      createdAt: '2026-08-09T12:34:56.000Z',
      jobKind: 'provider',
      providerAction: 'exec',
      request: {
        prompt: 'do the thing',
        cwd: canonicalProjectRoot,
        bypassPermissions: false,
        coralEnv: {},
      },
    };
    const session = {
      sessionId: source.sessionId,
      version: source.sessionVersion,
      activeJobId: record.operation.jobId,
    } as ProviderSession;
    const registerPersistedAuthorization = vi.fn();
    const rehydrateBinding = vi.fn();

    expect(
      materializeProviderOperationPrepare(
        {
          runtime: {
            time: { now: () => 100 },
            env: { platform: () => source.platform },
          } as ProviderOperationPrepareMaterializerDeps['runtime'],
          providerRegistry: {
            rehydrateBinding,
          } as unknown as ProviderOperationPrepareMaterializerDeps['providerRegistry'],
          childPrincipalRegistry: { registerPersistedAuthorization },
          readJobLaunch: () => launch,
          readSession: () => session,
        },
        record.operation,
        source,
      ),
    ).toEqual({
      state: 'permanent-refusal',
      code: 'authorization_expired',
      disposition: 'terminal-failure',
      reason: 'Provider operation child authorization has expired.',
    });
    expect(registerPersistedAuthorization).not.toHaveBeenCalled();
    expect(rehydrateBinding).not.toHaveBeenCalled();
  });

  it('rebuilds a fresh envelope from durable launch/session facts and a newly minted handle', () => {
    const record = providerOperationRecord('prepare-pending');
    if (record.phase !== 'prepare-pending') throw new Error('expected prepare-pending fixture');
    const binding = { provider: 'codex', kind: 'account', binding: { account: 'acct-1' } } as const;
    const launch: ProviderJobLaunch = {
      jobId: record.operation.jobId,
      owner: { kind: 'provider-session', id: record.prepareSource.sessionId },
      sessionId: record.prepareSource.sessionId,
      provider: 'codex',
      projectRoot: canonicalProjectRoot,
      backendNamespace: record.prepareSource.childAuthorization.namespace,
      pool: 'discuss',
      enqueueSequence: 1,
      createdAt: '2026-08-09T12:34:56.000Z',
      jobKind: 'provider',
      providerAction: 'exec',
      request: {
        prompt: 'durable prompt',
        cwd: canonicalProjectRoot,
        bypassPermissions: false,
        coralEnv: {},
      },
    };
    const session = {
      sessionId: record.prepareSource.sessionId,
      version: record.prepareSource.sessionVersion,
      activeJobId: record.operation.jobId,
      binding,
      conversationRef: 'durable-conversation',
      providerContinuity: { threadId: 'durable-thread' },
    } as unknown as ProviderSession;
    const registerPersistedAuthorization = vi.fn(() => ({ handle: 'fresh-random-handle' }));

    const prepared = materializeProviderOperationPrepare(
      {
        runtime: {
          time: { now: () => 1_000 },
          env: { platform: () => 'linux', fullSnapshot: () => ({ CURRENT_ENV: 'yes' }) },
          storage: {
            readFileSync: () => {
              throw new Error('no inject fixture');
            },
            statSync: () => {
              throw new Error('no equipped tool fixture');
            },
          },
          paths: {
            coral: {
              corpus: { kbRoot: '/coral/kb' },
              engine: { dataDir: (id: string) => `/coral/engines/${id}` },
            },
            projectData: () => '/coral/project-data',
            projectSource: () => canonicalProjectRoot,
          },
        } as unknown as ProviderOperationPrepareMaterializerDeps['runtime'],
        providerRegistry: {
          rehydrateBinding: () => ({
            ok: true,
            value: {
              name: 'codex',
              decodeContinuity: () => ({ ok: true, value: { threadId: 'durable-thread' } }),
            },
          }),
        } as unknown as ProviderOperationPrepareMaterializerDeps['providerRegistry'],
        childPrincipalRegistry: {
          registerPersistedAuthorization: registerPersistedAuthorization as never,
        },
        readJobLaunch: () => launch,
        readSession: () => session,
      },
      record.operation,
      record.prepareSource,
    );

    expect(prepared).toMatchObject({
      state: 'prepared',
      prepared: {
        provider: 'codex',
        binding,
        request: {
          sessionId: record.prepareSource.sessionId,
          prompt: 'durable prompt',
          conversationRef: 'durable-conversation',
        },
        persistedContinuity: { threadId: 'durable-thread' },
        baseEnv: { CURRENT_ENV: 'yes' },
        protectedEnv: {
          CORAL_JOB_ID: record.operation.jobId,
          CORAL_SESSION_ID: record.prepareSource.sessionId,
          CORAL_CHILD_PRINCIPAL_HANDLE: 'fresh-random-handle',
        },
        platform: 'linux',
      },
    });
    expect(registerPersistedAuthorization).toHaveBeenCalledWith({
      issuer: 'provider-operation-reprepare',
      authorization: record.prepareSource.childAuthorization,
      parentJobId: record.operation.jobId,
      parentSessionId: record.prepareSource.sessionId,
      nowMs: 1_000,
    });
  });
});
