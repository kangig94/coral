import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { readLaunchStatus } from '#src/infra/launch-status.js';
import { selectNextCandidate } from '#src/coordinator-launch/candidate-selection.js';
import { controllerBuild } from '#src/coordinator-launch/controller-build.js';
import { SupervisorLaunchMemory } from '#src/coordinator-launch/state.js';
import { strictBundleManifestSchema } from '#src/infra/bundle-manifest.js';
import { providerHandoffCapsulePath } from '#src/infra/path/provider-proxy.js';
import * as nodeProcess from '#src/infra/node-process.js';
import * as capsuleDiscovery from '#src/provider-proxy/handoff-capsule-discovery.js';
import { decodeHandoffCapsule } from '#src/provider-proxy/handoff-capsule.js';
import { JobLocationIndex } from '#src/jobs/location-index.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { custodyLedgerDir, reconcileCustodyLedger } from '#src/store/custody-ledger.js';

vi.mock('node:timers/promises', () => ({ setTimeout: async () => {} }));
afterEach(() => vi.restoreAllMocks());

it.each([
  'malformed',
  'read-error',
  'mode-drift',
  'owner-drift',
  'v2-reused-pid',
  'unknown-incarnation',
  'custody',
  'custody-with-readable-job',
  'live',
  'required-build-missing',
] as const)('bounds launch refusal for %s without discharging its subject', async (scenario) => {
  const root = mkdtempSync(join(tmpdir(), 'coral-controller-bound-'));
  try {
    const plugin = join(root, 'plugin');
    cpSync('clients/build', join(plugin, 'bridge'), { recursive: true });
    const manifest = strictBundleManifestSchema.parse(
      JSON.parse(readFileSync(join(plugin, 'bridge/manifest.v2.json'), 'utf8')),
    );
    const runtime = createRealRuntime('prod', { baseDir: join(root, '.coral') });
    const runDir = runtime.paths.coral.coordinator.runDir;
    mkdirSync(runDir, { recursive: true });
    const incarnation = nodeProcess.probeProcessIncarnation(process.pid)!;
    const record = new SupervisorLaunchMemory(runDir, { pid: process.pid, incarnation }, manifest.buildSetId);
    const input = {
      record,
      owner: { current: record.read().owner, lost: false, release: () => {} },
      runDir,
      original: { executable: join(plugin, 'bridge/coral-backend.cjs'), buildSetId: manifest.buildSetId },
      originalManifest: manifest,
      tried: new Set<string>(),
      firstLaunch: true,
      unidentifiedBinder: { observed: false },
    };
    expect((await selectNextCandidate(input)).kind).toBe('candidate');
    let subject: string;
    if (scenario === 'custody' || scenario === 'custody-with-readable-job') {
      subject = join(custodyLedgerDir(runDir), '11111111-1111-4111-8111-111111111111');
      mkdirSync(subject, { recursive: true });
      writeFileSync(join(subject, 'intent.v1.json'), '{');
      const observe = vi.fn(() => ({
        kind: 'absent' as const,
        processToken: 'unobserved',
        evidence: 'must never run',
      }));
      expect(reconcileCustodyLedger(runtime, runDir, Number.MAX_SAFE_INTEGER, 0, observe)[0].kind).toBe('unreadable');
      expect(observe).not.toHaveBeenCalled();
      if (scenario === 'custody-with-readable-job') {
        const epochKey = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:1';
        new JobLocationIndex(runtime, runtime.paths.coral.generation.dataRoot).register('job-live', epochKey, {
          projectRoot: root,
          workDir: null,
          jobKind: 'provider',
        });
        const id = '22222222-2222-4222-8222-222222222222';
        const path = join(custodyLedgerDir(runDir), id);
        mkdirSync(path, { recursive: true });
        writeFileSync(
          join(path, 'intent.v1.json'),
          JSON.stringify({
            version: 'v1',
            id,
            effect: 'process-spawn',
            epoch: '1',
            epochKey,
            owner: 'durable-cli',
            operationId: 'job-live',
            jobId: 'job-live',
            processToken: id,
            capsule: null,
            createdAtMs: 1,
            bindDeadlineMs: 10000,
          }),
        );
      }
    } else {
      const capsule = decodeHandoffCapsule(
        Buffer.from(
          JSON.stringify({
            version: scenario === 'v2-reused-pid' ? 2 : 3,
            grantId: '11111111-1111-4111-8111-111111111111',
            secret: 'a'.repeat(64),
            generation: 'gen2',
            flavor: 'prod',
            buildSetId:
              scenario === 'required-build-missing' ? '66666666-6666-4666-8666-666666666666' : manifest.buildSetId,
            hostFingerprint: 'd'.repeat(64),
            guardianInstanceId: '33333333-3333-4333-8333-333333333333',
            reaperInstanceId: '44444444-4444-4444-8444-444444444444',
            proxyInstanceId: '55555555-5555-4555-8555-555555555555',
            guardianControlEndpoint: '/tmp/g.sock',
            reaperControlEndpoint: '/tmp/r.sock',
            proxyEndpoint: '/tmp/p.sock',
            orphanTimeoutMs: 30000,
            teardownReserveMs: 14000,
            guardianPid: 2147483647,
            reaperPid: 2147483647,
            proxyPid: process.pid,
            ...(scenario === 'v2-reused-pid'
              ? {
                  guardianProcessStartedAtSeconds: 1,
                  reaperProcessStartedAtSeconds: 1,
                  proxyProcessStartedAtSeconds: 1,
                }
              : { guardianIncarnation: incarnation, reaperIncarnation: incarnation, proxyIncarnation: incarnation }),
            containmentKind: 'detached-process-group',
            proxyProcessGroupId: process.pid,
          }),
        ),
      );
      subject = providerHandoffCapsulePath(capsule, capsule.version, { baseDir: join(root, '.coral') });
      writeFileSync(subject, scenario === 'malformed' ? '{' : JSON.stringify(capsule), { mode: 0o600 });
      if (scenario === 'required-build-missing')
        writeFileSync(join(runDir, 'provider-1eeeeeeeeeeeeeeeeeeeeeee.handoff.v3.json'), '{', { mode: 0o600 });
      if (scenario === 'mode-drift') chmodSync(subject, 0o644);
      if (scenario === 'owner-drift') vi.spyOn(process, 'getuid').mockReturnValue((process.getuid?.() ?? 0) + 1);
      if (scenario === 'read-error')
        vi.spyOn(capsuleDiscovery, 'readProviderHandoffCapsuleCandidate').mockImplementation(() => {
          throw Object.assign(new Error('EIO'), { code: 'EIO' });
        });
      if (scenario === 'unknown-incarnation') vi.spyOn(nodeProcess, 'probeProcessIncarnation').mockReturnValue(null);
    }
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const kill = vi.spyOn(process, 'kill');
    const clock = vi.spyOn(process.hrtime, 'bigint').mockReturnValue(0n);
    if (scenario === 'live') {
      expect(controllerBuild(runDir)).toMatchObject({ kind: 'required', buildSetId: manifest.buildSetId });
      expect((await selectNextCandidate(input)).kind).toBe('candidate');
    } else if (scenario === 'v2-reused-pid') expect(controllerBuild(runDir).kind).toBe('none');
    else expect((await selectNextCandidate(input)).kind).toBe('retry');
    if (scenario !== 'live' && scenario !== 'v2-reused-pid') {
      clock.mockReturnValue(1_999_000_000n);
      expect((await selectNextCandidate(input)).kind).toBe('retry');
    }
    clock.mockReturnValue(2_000_000_000n);
    if (scenario === 'required-build-missing') {
      expect(controllerBuild(runDir)).toMatchObject({
        kind: 'required',
        buildSetId: '66666666-6666-4666-8666-666666666666',
      });
      expect((await selectNextCandidate(input)).kind).toBe('retry');
      const status = readLaunchStatus(runDir);
      expect(status).toMatchObject({
        kind: 'readable',
        status: { hold: { kind: 'no-eligible-build', retry: 'eligible-build-appears' } },
      });
      if (status.kind !== 'readable') throw new Error('Expected a readable hold');
      expect(status.status.hold).not.toHaveProperty('boundedExit');
      expect(existsSync(subject)).toBe(true);
      expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
      return;
    }
    expect(await selectNextCandidate(input)).toEqual({ kind: 'candidate', candidate: input.original });
    expect(existsSync(subject)).toBe(true);
    if (scenario !== 'live' && scenario !== 'v2-reused-pid') {
      const status = readLaunchStatus(runDir);
      expect(status).toMatchObject({ kind: 'readable', status: { controllerEvidenceRefusals: [{ path: subject }] } });
      expect(
        stderr.mock.calls.filter(([message]) => String(message).includes('Controller evidence refused path=')),
      ).toHaveLength(1);
    }
    expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
