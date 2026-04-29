// Phase 7 of apply-contract-reform plan.
//
// AC11 wired `/health.subsystems.kb` from a string union to a typed object
// carrying `kind`, optional `reason`, and optional `mutationBlocked` /
// `consumerStuck` diagnostic sub-fields. These tests pin the typed shape
// from the validator's perspective so external consumers (CLI, polling
// scripts) can rely on the structure.

import { describe, expect, it } from 'vitest';

import { isBackendHealth, type BackendHealth } from '#src/transport/http/backend/health.js';

const HEALTHY_BASE: BackendHealth = {
  status: 'ok',
  version: '0.5.2',
  bundleHash: 'hash-1234',
  flavor: 'prod',
  instanceId: 'instance-1',
  namespace: 'test-ns',
  uptimeMs: 1000,
  active: 0,
  activeJobs: 0,
  inflightRequests: 0,
  queueDepth: 0,
  subsystems: {
    kb: { kind: 'ok' },
    kbCurate: 'ok',
    discuss: 'ok',
  },
};

describe('/health typed subsystems.kb shape (Phase 7 / AC11)', () => {
  it('accepts a healthy shape with `kind: "ok"` and no diagnostics', () => {
    expect(isBackendHealth(HEALTHY_BASE)).toBe(true);
  });

  it('accepts a blocked-mutation shape carrying full diagnostic context', () => {
    const blocked: BackendHealth = {
      ...HEALTHY_BASE,
      subsystems: {
        ...HEALTHY_BASE.subsystems,
        kb: {
          kind: 'ok',
          mutationBlocked: { owner: 'reindex', ageMs: 5000, signaledAtMs: 1234567890 },
        },
      },
    };
    expect(isBackendHealth(blocked)).toBe(true);
  });

  it('accepts a stuck-consumer shape carrying per-consumer elapsedSinceStopMs', () => {
    const stuck: BackendHealth = {
      ...HEALTHY_BASE,
      subsystems: {
        ...HEALTHY_BASE.subsystems,
        kb: {
          kind: 'ok',
          consumerStuck: [
            { id: 'orama-base', elapsedSinceStopMs: 2500 },
            { id: 'needle-base', elapsedSinceStopMs: 100 },
          ],
        },
      },
    };
    expect(isBackendHealth(stuck)).toBe(true);
  });

  it('accepts an unavailable shape with `reason`', () => {
    const unavailable: BackendHealth = {
      ...HEALTHY_BASE,
      subsystems: {
        ...HEALTHY_BASE.subsystems,
        kb: { kind: 'unavailable', reason: 'KB init failed' },
      },
    };
    expect(isBackendHealth(unavailable)).toBe(true);
  });

  it('rejects a `mutationBlocked` shape missing required diagnostic fields', () => {
    const malformed = {
      ...HEALTHY_BASE,
      subsystems: {
        ...HEALTHY_BASE.subsystems,
        kb: {
          kind: 'ok',
          // missing ageMs and signaledAtMs
          mutationBlocked: { owner: 'reindex' },
        },
      },
    };
    expect(isBackendHealth(malformed)).toBe(false);
  });

  it('rejects a `consumerStuck` entry missing elapsedSinceStopMs', () => {
    const malformed = {
      ...HEALTHY_BASE,
      subsystems: {
        ...HEALTHY_BASE.subsystems,
        kb: {
          kind: 'ok',
          consumerStuck: [{ id: 'orama-base' }],
        },
      },
    };
    expect(isBackendHealth(malformed)).toBe(false);
  });

  it('rejects the legacy flat string-union shape (clean-slate cost)', () => {
    // Pre-rewrite responses returned `subsystems.kb` as a string ('ok' /
    // 'unavailable') alongside a flat `kbReason`. The new validator must
    // fail-loud on that shape to surface the contract change rather than
    // silently parse it as a degenerate typed object.
    const legacy = {
      ...HEALTHY_BASE,
      subsystems: {
        ...HEALTHY_BASE.subsystems,
        kb: 'ok',
      },
    };
    expect(isBackendHealth(legacy)).toBe(false);
  });

  it('rejects an unknown `kind` string in subsystems.kb', () => {
    const malformed = {
      ...HEALTHY_BASE,
      subsystems: {
        ...HEALTHY_BASE.subsystems,
        kb: { kind: 'degraded' },
      },
    };
    expect(isBackendHealth(malformed)).toBe(false);
  });
});
