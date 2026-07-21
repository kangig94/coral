// Invariant #9: `continuity` bodies are full snapshots, never patches.
//
// Pins the structural guarantee that `session.continuity.checkpointed` only
// accepts a complete `ContinuitySnapshot` shape — no `delta`, `ops`, or
// otherwise patch-flavored body. Future patch-style additions to the schema
// would break this test.

import { describe, expect, it } from 'vitest';

import { continuitySnapshotSchema } from '#src/sessions/continuity.js';
import { sessionContinuityMutationSchema } from '#src/sessions/continuity-mutation.js';
import { sessionContinuityCheckpointedBodySchema } from '#src/sessions/event-bodies.js';

describe('Invariant #9 — continuity bodies are full snapshots', () => {
  it('continuitySnapshotSchema accepts a complete snapshot', () => {
    const snapshot = {
      conversationRef: 'conv-1',
      resumable: true,
      providerContinuity: { threadId: 't-1' },
    };
    expect(continuitySnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  it('continuitySnapshotSchema rejects partial/patch shapes', () => {
    const patch = { delta: { conversationRef: 'conv-1' } };
    const opList = { ops: [{ op: 'set', path: 'conversationRef', value: 'conv-1' }] };
    const partial = { conversationRef: 'conv-1' }; // missing resumable + providerContinuity
    expect(continuitySnapshotSchema.safeParse(patch).success).toBe(false);
    expect(continuitySnapshotSchema.safeParse(opList).success).toBe(false);
    expect(continuitySnapshotSchema.safeParse(partial).success).toBe(false);
  });

  it('continuitySnapshotSchema rejects extra fields (strict object)', () => {
    const withExtra = {
      conversationRef: 'conv-1',
      resumable: true,
      providerContinuity: { threadId: 't-1' },
      patchSeq: 7, // a patch-style versioning hint must NOT be acceptable
    };
    expect(continuitySnapshotSchema.safeParse(withExtra).success).toBe(false);
  });

  it('rejects empty continuity refs instead of treating them as absence or clear', () => {
    expect(
      continuitySnapshotSchema.safeParse({
        conversationRef: '',
        resumable: true,
        providerContinuity: null,
      }).success,
    ).toBe(false);
    expect(
      sessionContinuityMutationSchema.safeParse({
        kind: 'set_resumable',
        conversationRef: '',
      }).success,
    ).toBe(false);
  });

  it('session.continuity.checkpointed body requires entry + full snapshot', () => {
    const entry = {
      sessionId: 's-1',
      provider: 'codex',
      sessionAuthority: { kind: 'orchestration' as const },
      name: 'session-name',
      state: 'ready' as const,
      cwd: '/workspace/coral',
      projectRoot: '/workspace/coral',
      backendNamespace: 'tests',
      providerContinuity: null,
      createdAt: '2026-04-19T00:00:00.000Z',
      lastUsedAt: '2026-04-19T00:00:00.000Z',
      version: 1,
    };
    const ok = {
      entry,
      snapshot: { conversationRef: 'conv-1', resumable: true, providerContinuity: null },
    };
    // Body parsing requires the full continuity snapshot — patch shapes are
    // rejected by the strict schema before the reducer ever runs.
    expect(sessionContinuityCheckpointedBodySchema.safeParse(ok).success).toBe(true);
    expect(sessionContinuityCheckpointedBodySchema.safeParse({ entry, snapshot: { delta: {} } }).success).toBe(false);
    expect(sessionContinuityCheckpointedBodySchema.safeParse({ entry }).success).toBe(false);
  });
});
