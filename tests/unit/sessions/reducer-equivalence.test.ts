import { describe, expect, it } from 'vitest';
import { providerSessionSchema, type ProviderSession } from '#src/sessions/entry.js';
import { sessionArtifactHandleRecordedBodySchema } from '#src/sessions/event-bodies.js';
import { providerArtifactIdentityKey } from '#src/providers/artifact-identity.js';
import { TEST_CODEX_BINDING } from '#tests/helpers/provider-credentials.js';

const NOW = new Date('2026-04-19T00:00:00.000Z');

function sessionEntry(overrides: Partial<ProviderSession> & Pick<ProviderSession, 'sessionId'>): ProviderSession {
  return {
    sessionId: overrides.sessionId,
    binding: overrides.binding ?? TEST_CODEX_BINDING,
    name: overrides.name ?? overrides.sessionId,
    state: overrides.state ?? 'pending',
    retention: overrides.retention ?? 'retain',
    artifactHandles: overrides.artifactHandles ?? [],
    retentionDiscard: overrides.retentionDiscard ?? { attempts: [] },
    cwd: overrides.cwd ?? '/tmp/project',
    projectRoot: overrides.projectRoot ?? '/tmp/project',
    backendNamespace: overrides.backendNamespace ?? 'ns-a',
    providerContinuity: overrides.providerContinuity ?? null,
    createdAt: overrides.createdAt ?? NOW.toISOString(),
    lastUsedAt: overrides.lastUsedAt ?? NOW.toISOString(),
    version: overrides.version ?? 1,
    ...(overrides.activeJobId === undefined ? {} : { activeJobId: overrides.activeJobId }),
    ...(overrides.conversationRef === undefined ? {} : { conversationRef: overrides.conversationRef }),
    ...(overrides.model === undefined ? {} : { model: overrides.model }),
    ...(overrides.agentName === undefined ? {} : { agentName: overrides.agentName }),
    ...(overrides.instruction === undefined ? {} : { instruction: overrides.instruction }),
    ...(overrides.bypassPermissions === undefined ? {} : { bypassPermissions: overrides.bypassPermissions }),
    ...(overrides.systemPrompt === undefined ? {} : { systemPrompt: overrides.systemPrompt }),
    ...(overrides.controllerProfile === undefined ? {} : { controllerProfile: overrides.controllerProfile }),
  };
}

describe('sessions reducer equivalence', () => {
  it('requires artifact identity and job ownership to match the session binding exactly', () => {
    const identity = { kind: 'codex-rollout' as const, threadId: 'thread-artifact' };
    const identityKey = providerArtifactIdentityKey('codex', identity);
    const entry = sessionEntry({
      sessionId: 'session-artifact-authority',
      artifactHandles: [
        {
          handle: '/tmp/codex/rollout.jsonl',
          identity,
          identityKey,
          sourceJobId: 'job-artifact',
          recordedAt: NOW.toISOString(),
        },
      ],
    });

    expect(() =>
      providerSessionSchema.parse({
        ...entry,
        artifactHandles: [{ ...entry.artifactHandles[0], identityKey: 'not-derived-from-binding' }],
      }),
    ).toThrow();
    expect(() =>
      sessionArtifactHandleRecordedBodySchema.parse({
        entry,
        provider: 'codex',
        handle: '/tmp/codex/rollout.jsonl',
        identity,
        identityKey,
        sourceJobId: 'job-artifact',
      }),
    ).toThrow();
    expect(() =>
      sessionArtifactHandleRecordedBodySchema.parse({
        entry,
        handle: '/tmp/codex/rollout.jsonl',
        identity,
        identityKey,
      }),
    ).toThrow();
  });
});
