import { describe, expect, it } from 'vitest';

import {
  providerHostEvictRpcSpec,
  providerHostInspectRpcSpec,
  providerHostListRpcSpec,
  providerHostListV2RpcSpec,
  providerProxySetContainBooleanRpcSpec,
  providerProxySetContainRpcSpec,
  jobsAbortRpcSpec,
} from '#src/transport/rpc/catalog.js';
import {
  ipcRouteLifecycleAdmission,
  ipcRouteRefusalDisposition,
  operationalRouteSpecs,
  readIpcOperationalSpec,
  type IpcOperationalSpec,
} from '#src/transport/rpc/operational-catalog.js';

const ipcSpecs: readonly IpcOperationalSpec[] = operationalRouteSpecs.flatMap((spec) =>
  spec.transport === 'ipc' ? [spec] : [],
);

describe('operational catalog IPC lifecycle admission', () => {
  it.each([
    jobsAbortRpcSpec.name,
    providerProxySetContainRpcSpec.name,
    providerProxySetContainBooleanRpcSpec.name,
    providerHostListRpcSpec.name,
    providerHostListV2RpcSpec.name,
    providerHostInspectRpcSpec.name,
    providerHostEvictRpcSpec.name,
    'transport.health',
  ])('admits %s while the coordinator drains', (method) => {
    expect(ipcRouteLifecycleAdmission(method)).toBe('running-or-draining');
  });

  it.each(['jobs.list', 'sessions.create', 'transport.kb.restart', 'no.such.method'])(
    'requires a running coordinator for %s',
    (method) => {
      expect(ipcRouteLifecycleAdmission(method)).toBe('running');
    },
  );

  it('derives admission from requiresRunningLifecycle for every IPC operational spec', () => {
    const mismatched = ipcSpecs.filter(
      (spec) =>
        ipcRouteLifecycleAdmission(spec.ipc.method) !==
        (spec.requiresRunningLifecycle ? 'running' : 'running-or-draining'),
    );

    expect(ipcSpecs.length).toBeGreaterThan(0);
    expect(mismatched.map((spec) => spec.id)).toEqual([]);
  });
});

describe('operational catalog IPC refusal disposition', () => {
  it.each([jobsAbortRpcSpec.name, providerProxySetContainRpcSpec.name, providerProxySetContainBooleanRpcSpec.name])(
    'lets a successor discharge %s',
    (method) => {
      expect(ipcRouteRefusalDisposition(method)).toBe('spawn-successor');
    },
  );

  it.each([
    providerHostListRpcSpec.name,
    providerHostListV2RpcSpec.name,
    providerHostInspectRpcSpec.name,
    providerHostEvictRpcSpec.name,
  ])('reports the refusal for %s, which no successor could discharge', (method) => {
    expect(readIpcOperationalSpec(method)?.dispatch.kind).toBe('catalog');
    expect(ipcRouteRefusalDisposition(method)).toBe('report-refusal');
  });

  it.each(['transport.health', 'jobs.list', 'no.such.method'])(
    'reports the refusal for %s, which no catalog dispatch admits',
    (method) => {
      expect(readIpcOperationalSpec(method)?.dispatch.kind).not.toBe('catalog');
      expect(ipcRouteRefusalDisposition(method)).toBe('report-refusal');
    },
  );
});
