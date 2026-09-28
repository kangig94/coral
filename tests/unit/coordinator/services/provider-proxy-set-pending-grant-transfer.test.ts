import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { providerProxySetIdentityFromRecord } from '#src/coordinator/services/provider-proxy-set/identity.js';
import {
  readPendingGrantTransfer,
  recordPendingGrantTransfer,
} from '#src/coordinator/services/provider-proxy-set/pending-grant-transfer.js';
import type { HandoffCapsuleV4 } from '#src/provider-proxy/handoff-capsule.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';

const INCUMBENT_BUILD = '11111111-1111-4111-8111-111111111111';
const SUCCESSOR_BUILD = '22222222-2222-4222-8222-222222222222';
const RECOVERY_GRANT = '33333333-3333-4333-8333-333333333333';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function capsule(): HandoffCapsuleV4 {
  const identity = providerProxySetIdentityFromRecord(providerOperationRecord('executing'));
  return {
    version: 4,
    controllerBuildSetId: INCUMBENT_BUILD,
    grantId: RECOVERY_GRANT,
    secret: 'e'.repeat(64),
    generation: 'gen2',
    flavor: 'prod',
    buildSetId: identity.buildSetId,
    hostFingerprint: identity.hostFingerprint,
    guardianInstanceId: identity.guardianInstanceId,
    reaperInstanceId: identity.reaperInstanceId,
    proxyInstanceId: identity.proxyInstanceId,
    guardianControlEndpoint: identity.guardianControlEndpoint,
    reaperControlEndpoint: identity.reaperControlEndpoint,
    proxyEndpoint: identity.canonicalEndpoint,
    orphanTimeoutMs: 30_000,
    teardownReserveMs: 14_000,
    guardianPid: identity.guardianPid,
    guardianIncarnation: identity.guardianIncarnation,
    proxyPid: identity.proxyPid,
    reaperPid: identity.reaperPid,
    reaperIncarnation: identity.reaperIncarnation,
    containmentKind: identity.containmentKind,
    proxyIncarnation: identity.proxyIncarnation,
    proxyProcessGroupId: identity.proxyProcessGroupId,
  };
}

describe('pending provider grant transfer', () => {
  it('preserves an additive field when a later attempt rewrites the same grant status', () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-pending-grant-additive-'));
    roots.push(root);
    const runtime = createRealRuntime('prod', { baseDir: join(root, '.coral') });
    const handoff = capsule();
    expect(recordPendingGrantTransfer(runtime, handoff, SUCCESSOR_BUILD, 'attempt-1')).toEqual({ kind: 'recorded' });
    const name = runtime.storage
      .readdirSync(runtime.paths.coral.coordinator.runDir)
      .find((entry) => entry.startsWith('provider-grant-transfer-'));
    if (name === undefined) throw new Error('expected pending transfer status');
    const path = join(runtime.paths.coral.coordinator.runDir, name);
    const prior = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    runtime.storage.writeAtomicDurableSync(path, `${JSON.stringify({ ...prior, futureField: 'keep' })}\n`);

    expect(recordPendingGrantTransfer(runtime, handoff, SUCCESSOR_BUILD, 'attempt-2')).toEqual({ kind: 'recorded' });
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toMatchObject({ attemptId: 'attempt-2', futureField: 'keep' });
  });
  it('holds an unreadable newer status with its retry exit instead of accepting it', () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-red-pending-grant-'));
    roots.push(root);
    const runtime = createRealRuntime('prod', { baseDir: join(root, '.coral') });
    const handoff = capsule();

    expect(recordPendingGrantTransfer(runtime, handoff, SUCCESSOR_BUILD, 'attempt-1')).toEqual({ kind: 'recorded' });
    const status = runtime.storage
      .readdirSync(runtime.paths.coral.coordinator.runDir)
      .find((entry) => entry.startsWith('provider-grant-transfer-'));
    if (status === undefined) throw new Error('expected pending transfer status');
    runtime.storage.writeAtomicDurableSync(join(runtime.paths.coral.coordinator.runDir, status), '{"version":2}\n', {
      encoding: 'utf-8',
      mode: 0o600,
    });

    expect(readPendingGrantTransfer(runtime, handoff, SUCCESSOR_BUILD)).toEqual({
      kind: 'unreadable',
      disposition: 'held',
      waitingFor: 'durable-status-read',
      exit: 'provider-set-inheritance-retry',
    });
  });
});
