import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  PROVIDER_OPERATION_RECORD_GENERATIONS,
  PROVIDER_OPERATION_RECORD_VERSION,
} from '#src/store/provider-operation-record.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

function source(path: string): string {
  return readFileSync(join(REPO_ROOT, path), 'utf8');
}

describe('provider operation durable generations', () => {
  it('owns current and retained generations beside the schema and derives journal addressing from them', () => {
    const journal = source('src/store/provider-operation-journal.ts');

    expect(PROVIDER_OPERATION_RECORD_VERSION).toBe(PROVIDER_OPERATION_RECORD_GENERATIONS.current);
    expect(journal).toContain('PROVIDER_OPERATION_RECORD_GENERATIONS.retainedSuperseded.map');
    expect(journal).not.toContain('SUPERSEDED_PROVIDER_OPERATION_RECORD_VERSIONS');
    expect(journal).not.toMatch(/sagaPrefix\(\s*\d/u);
  });

  it('does not let V3 capsule scenarios regress to V2 names or proof labels', () => {
    for (const path of [
      'tests/unit/coordinator/services/provider-proxy-set-lifecycle.test.ts',
      'tests/integration/coordinator/provider-proxy-startup.integration.test.ts',
    ]) {
      expect(source(path), path).not.toMatch(/exact[- ]v2/u);
    }
  });
});

describe('other durable and wire generations', () => {
  it('derives durable CLI meta and active-store addresses from their payload generations', () => {
    const runtimeMeta = source('src/jobs/runtime-meta.ts');
    const launch = source('src/jobs/shell/launch.ts');
    const activeStore = source('src/store/active-store-selection.ts');
    const activeStoreCoordination = source('src/store/active-store-selection-coordination.ts');
    const backendReset = source('src/store/backend-store-reset.ts');

    expect(runtimeMeta).toContain('z.literal(DURABLE_CLI_PROCESS_RUNTIME_META_VERSION)');
    expect(runtimeMeta).toContain('durable_cli_process.v${DURABLE_CLI_PROCESS_RUNTIME_META_VERSION}');
    expect(launch).toContain('version: DURABLE_CLI_PROCESS_RUNTIME_META_VERSION');
    expect(activeStore).toContain('active-store-selection.v${ACTIVE_STORE_SELECTION_VERSION}');
    expect(activeStore).toContain('active-store-transition.v${ACTIVE_STORE_TRANSITION_VERSION}');
    expect(activeStore).toContain('z.literal(ACTIVE_STORE_SELECTION_VERSION)');
    expect(activeStore).toContain('z.literal(ACTIVE_STORE_TRANSITION_VERSION)');
    expect(activeStoreCoordination).toContain('version: ACTIVE_STORE_SELECTION_VERSION');
    expect(activeStoreCoordination).toContain('version: ACTIVE_STORE_TRANSITION_VERSION');
    expect(backendReset).toContain('active-store-transition.v${ACTIVE_STORE_TRANSITION_VERSION}');
    expect(source('src/coordinator/lifecycle.ts')).toContain('version: ACTIVE_STORE_SELECTION_VERSION');
  });

  it('derives prepared-operation, handoff-signal, and bootstrap readers and writers from one owner each', () => {
    const protocol = source('src/provider-proxy/protocol.ts');
    const launchRoute = source('src/coordinator/services/provider-proxy-launch-route.ts');
    const reprepare = source('src/coordinator/services/provider-operation-prepare.ts');
    const handoff = source('src/coordinator/handoff.ts');
    const bootstrap = source('src/coordinator/bootstrap-diagnostics.ts');
    const ensure = source('src/transport/ipc/ensure.ts');
    const status = source('src/transport/http/backend/status.ts');

    expect(protocol).toContain('z.literal(PROXY_PREPARED_APP_SERVER_OPERATION_VERSION)');
    expect(launchRoute).toContain('version: PROXY_PREPARED_APP_SERVER_OPERATION_VERSION');
    expect(reprepare).toContain('version: PROXY_PREPARED_APP_SERVER_OPERATION_VERSION');
    expect(handoff).toContain('version: typeof HANDOFF_SIGNAL_RECORD_VERSION');
    expect(handoff).toContain('record.version === HANDOFF_SIGNAL_RECORD_VERSION');
    expect(handoff).toContain('version: HANDOFF_SIGNAL_RECORD_VERSION');
    expect(bootstrap).toContain('schemaVersion: BOOTSTRAP_DIAGNOSTIC_SCHEMA_VERSION');
    expect(bootstrap).toContain('version: STARTUP_ERROR_SENTINEL_VERSION');
    expect(status).toContain('value.schemaVersion !== BOOTSTRAP_DIAGNOSTIC_SCHEMA_VERSION');
    expect(ensure).toContain('value.version === STARTUP_ERROR_SENTINEL_VERSION');
  });

  it('derives retained reset and KB generations from their owner registries', () => {
    const resetIncident = source('src/store/reset-incident.ts');
    const backendReset = source('src/store/backend-store-reset.ts');
    const resetReader = source('src/store/reset-incident-reader.ts');
    const kbRuntime = source('src/kb/runtime.ts');
    const kbProjection = source('src/kb/corpus/projection-lifecycle.ts');

    expect(resetIncident).toContain('STORE_RESET_INCIDENT_SCHEMA_GENERATIONS.current');
    expect(resetIncident).toContain('STORE_RESET_INCIDENT_SCHEMA_GENERATIONS.retainedReadable[0]');
    expect([resetIncident, backendReset, resetReader].join('\n')).not.toMatch(/schemaVersion\s*[!=]==?\s*3/u);
    expect(backendReset).toContain('schemaVersion: STORE_RESET_INCIDENT_SCHEMA_VERSION');
    expect(kbProjection).toContain('CORPUS_PROJECTION_COMMIT_SCHEMA_GENERATIONS.current');
    expect(kbProjection).toContain('schemaVersion: typeof CORPUS_PROJECTION_COMMIT_SCHEMA_VERSION');
    expect(kbRuntime).toContain('CORPUS_PROJECTION_COMMIT_SCHEMA_GENERATIONS.retainedSupported');
    expect(kbRuntime).toContain(
      '[CORPUS_PROJECTION_COMMIT_SCHEMA_GENERATIONS.retainedSupported[0]]: decodeCorpusProjectionCommitRecord',
    );
  });

  it('has one owner for the current state and wire generation', () => {
    const consumers = [
      'src/infra/path/root.ts',
      'src/infra/path/provider-proxy.ts',
      'src/provider-proxy/protocol.ts',
      'src/coordinator/live/provider-hosts/proxy-set-acquisition.ts',
      'src/coordinator/services/provider-proxy-set/inheritance.ts',
    ];

    expect(source('src/infra/state-generation.ts')).toContain("CURRENT_STATE_GENERATION = 'gen2'");
    for (const path of consumers) {
      expect(source(path), path).toContain('CURRENT_STATE_GENERATION');
      expect(source(path), path).not.toContain("'gen2'");
    }
  });
});
