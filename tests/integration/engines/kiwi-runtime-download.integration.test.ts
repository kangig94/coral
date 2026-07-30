import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { KIWI_NLP_PACKAGE_URL, KIWI_NLP_VERSION, KIWI_WASM_SHA256 } from '#src/engines/kiwi/constants.js';
import { ensureKiwiWasmArtifactLocked } from '#src/engines/kiwi/wasm-artifact.js';
import { createRealRuntime } from '#src/runtime/real.js';

const networkTest = process.env.CORAL_TEST_NETWORK === '1' ? it : it.skip;

describe('Kiwi pinned runtime download', () => {
  networkTest('downloads, verifies, extracts, and publishes the pinned npm WASM artifact', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-kiwi-network-'));
    const runtime = createRealRuntime('prod', { baseDir: root });
    try {
      const installed = await ensureKiwiWasmArtifactLocked(runtime);

      expect(installed).toMatchObject({
        installed: true,
        payloadValid: true,
        payloadSha256: KIWI_WASM_SHA256,
        manifest: {
          kiwiNlpVersion: KIWI_NLP_VERSION,
          sourceUrl: KIWI_NLP_PACKAGE_URL,
          wasmSha256: KIWI_WASM_SHA256,
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
