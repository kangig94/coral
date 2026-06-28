import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  KIWI_INSTALL_ONLY_ID,
  KIWI_MODEL_ARCHIVE_SIZE_BYTES,
  KIWI_MODEL_FILES,
  KIWI_MODEL_SHA256,
  KIWI_MODEL_TYPE,
  KIWI_MODEL_URL,
  KIWI_MODEL_VERSION,
  KIWI_NLP_VERSION,
} from '#src/engines/kiwi/constants.js';
import { kiwiModelDir, kiwiModelFilePath, kiwiModelManifestPath } from '#src/engines/kiwi/paths.js';
import { BUNDLED_ENGINES, BUNDLED_INSTALL_ONLY_PACKAGES } from '#src/expansion/bundled.js';
import {
  computeEquippedTools,
  equippedToolsSnapshotSchema,
  writeEquippedToolsSnapshot,
} from '#src/expansion/equipped-tools.js';
import { INSTALL_ONLY_PACKAGES, resolveInstallOnlyManifest } from '#src/expansion/install-only.js';
import { composeCoralPaths } from '#src/infra/path/index.js';
import type { Runtime } from '#src/runtime/ports.js';
import { createRealRuntime } from '#src/runtime/real.js';

const CODEBASE_MEMORY = 'codebase-memory';
const BINARY = 'codebase-memory-mcp';
const ENGINE_IDS = ['needle', 'onnx', 'gemini', 'orama'] as const;
const createdRoots: string[] = [];

afterEach(() => {
  for (const root of createdRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createRuntime(): Runtime {
  const root = mkdtempSync(join(tmpdir(), 'coral-equipped-tools-'));
  createdRoots.push(root);
  const baseDir = join(root, '.coral');
  const real = createRealRuntime('prod');
  return { ...real, paths: { ...real.paths, coral: composeCoralPaths('prod', { baseDir }) } };
}

function installCodebaseMemory(runtime: Runtime): void {
  const dir = runtime.paths.coral.engine.dataDir(CODEBASE_MEMORY);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, BINARY), 'binary');
}

function installKiwiModelArtifact(runtime: Runtime): void {
  mkdirSync(kiwiModelDir(runtime), { recursive: true });
  for (const fileName of KIWI_MODEL_FILES) {
    writeFileSync(kiwiModelFilePath(runtime, fileName), 'fixture');
  }
  writeFileSync(
    kiwiModelManifestPath(runtime),
    `${JSON.stringify({
      packageId: KIWI_INSTALL_ONLY_ID,
      kiwiNlpVersion: KIWI_NLP_VERSION,
      modelVersion: KIWI_MODEL_VERSION,
      modelType: KIWI_MODEL_TYPE,
      sourceUrl: KIWI_MODEL_URL,
      archiveSha256: KIWI_MODEL_SHA256,
      archiveSizeBytes: KIWI_MODEL_ARCHIVE_SIZE_BYTES,
      files: [...KIWI_MODEL_FILES],
      installedAt: '2026-01-01T00:00:00.000Z',
    })}\n`,
  );
}

describe('equipped-tools', () => {
  it('surfaces nothing when no agent-facing tool is installed', () => {
    expect(computeEquippedTools(createRuntime())).toEqual([]);
  });

  it('surfaces codebase-memory with its agentSummary once its binary is present', () => {
    const runtime = createRuntime();
    installCodebaseMemory(runtime);
    const summary = resolveInstallOnlyManifest(CODEBASE_MEMORY)?.agentSummary;
    expect(summary).toBeTruthy();
    expect(computeEquippedTools(runtime)).toEqual([{ id: CODEBASE_MEMORY, summary }]);
  });

  it('never surfaces Coral engine ids because engines are not install-only packages', () => {
    const bundledEngineIds = BUNDLED_ENGINES.map((pkg) => pkg.id);
    const installOnlyIds = INSTALL_ONLY_PACKAGES.map((pkg) => pkg.id);

    for (const id of ENGINE_IDS) {
      expect(bundledEngineIds).toContain(id);
      expect(installOnlyIds).not.toContain(id);
    }

    const runtime = createRuntime();
    installCodebaseMemory(runtime);
    const equippedIds = computeEquippedTools(runtime).map((tool) => tool.id);
    expect(equippedIds).toEqual([CODEBASE_MEMORY]);
    for (const id of ENGINE_IDS) {
      expect(equippedIds).not.toContain(id);
    }
  });

  it('excludes Coral bundled install-only artifacts even when they are installed', () => {
    const bundledIds = BUNDLED_INSTALL_ONLY_PACKAGES.map((pkg) => pkg.id);
    // kiwi is install-only but internal KB plumbing (a tokenizer model) the agent
    // never calls - it must stay out of the surfaced set; codebase-memory must not.
    expect(bundledIds).toContain(KIWI_INSTALL_ONLY_ID);
    expect(bundledIds).not.toContain(CODEBASE_MEMORY);

    const runtime = createRuntime();
    installKiwiModelArtifact(runtime);
    installCodebaseMemory(runtime);
    expect(resolveInstallOnlyManifest(KIWI_INSTALL_ONLY_ID)?.installer.inspect(runtime, KIWI_INSTALL_ONLY_ID).installed).toBe(
      true,
    );
    expect(computeEquippedTools(runtime).map((tool) => tool.id)).toEqual([CODEBASE_MEMORY]);
  });

  it('writes a versioned snapshot to the coordinator run-dir', () => {
    const runtime = createRuntime();
    installCodebaseMemory(runtime);

    writeEquippedToolsSnapshot(runtime);

    const raw = runtime.storage.readFileSync(runtime.paths.coral.coordinator.equippedToolsFile, 'utf-8');
    const snapshot = equippedToolsSnapshotSchema.parse(JSON.parse(raw));
    expect(snapshot.version).toBe(1);
    expect(snapshot.tools).toEqual(computeEquippedTools(runtime));
    expect(snapshot.tools.map((tool) => tool.id)).toEqual([CODEBASE_MEMORY]);
  });
});
