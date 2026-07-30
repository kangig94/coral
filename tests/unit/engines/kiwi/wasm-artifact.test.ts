import {
  chmodSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { describe, expect, it, vi } from 'vitest';

import {
  KIWI_NLP_PACKAGE_INTEGRITY,
  KIWI_NLP_PACKAGE_SIZE_BYTES,
  KIWI_NLP_PACKAGE_URL,
  KIWI_NLP_VERSION,
  KIWI_WASM_TAR_ENTRY,
  KIWI_WASM_SHA256,
  KIWI_WASM_SIZE_BYTES,
} from '#src/engines/kiwi/constants.js';
import { kiwiWasmDir, kiwiWasmManifestPath, kiwiWasmPath } from '#src/engines/kiwi/paths.js';
import {
  ensureKiwiWasmArtifactLocked,
  extractKiwiWasm,
  inspectKiwiWasmArtifact,
  publishKiwiWasmArtifact,
  verifyKiwiNlpArchive,
} from '#src/engines/kiwi/wasm-artifact.js';
import { sha256Hex } from '#src/infra/hash.js';
import { createRealRuntime } from '#src/runtime/real.js';

const wasmFixture = readFileSync(join(process.cwd(), 'node_modules', 'kiwi-nlp', 'dist', 'kiwi-wasm.wasm'));

function writeTarString(header: Buffer, value: string, offset: number, length: number): void {
  Buffer.from(value, 'utf-8').copy(header, offset, 0, length);
}

function writeTarOctal(header: Buffer, value: number, offset: number, length: number): void {
  Buffer.from(`${value.toString(8).padStart(length - 1, '0')}\0`, 'utf-8').copy(header, offset, 0, length);
}

function createTarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512, 0);
  writeTarString(header, name, 0, 100);
  writeTarOctal(header, 0o644, 100, 8);
  writeTarOctal(header, 0, 108, 8);
  writeTarOctal(header, 0, 116, 8);
  writeTarOctal(header, size, 124, 12);
  writeTarOctal(header, 0, 136, 12);
  header.fill(0x20, 148, 156);
  header[156] = '0'.charCodeAt(0);
  writeTarString(header, 'ustar', 257, 6);
  writeTarString(header, '00', 263, 2);
  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  writeTarOctal(header, checksum, 148, 8);
  return header;
}

function createWasmArchive(path = KIWI_WASM_TAR_ENTRY, payload = wasmFixture): Buffer {
  const padding = Buffer.alloc((512 - (payload.length % 512)) % 512, 0);
  return gzipSync(Buffer.concat([createTarHeader(path, payload.length), payload, padding, Buffer.alloc(1024)]), {
    level: 1,
  });
}

function createTestRuntime() {
  const root = mkdtempSync(join(tmpdir(), 'coral-kiwi-wasm-'));
  return {
    root,
    runtime: createRealRuntime('prod', { baseDir: root }),
  };
}

describe('Kiwi WASM artifact', () => {
  it('pins the installed glue and WASM to the declared version and digest', () => {
    const projectPackage = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as {
      dependencies: Record<string, string>;
    };
    const lockfile = JSON.parse(readFileSync(join(process.cwd(), 'package-lock.json'), 'utf-8')) as {
      packages: Record<
        string,
        {
          version?: string;
          resolved?: string;
          integrity?: string;
          dependencies?: Record<string, string>;
        }
      >;
    };
    const packageJson = JSON.parse(
      readFileSync(join(process.cwd(), 'node_modules', 'kiwi-nlp', 'package.json'), 'utf-8'),
    ) as { version: string };

    expect(projectPackage.dependencies['kiwi-nlp']).toBe(KIWI_NLP_VERSION);
    expect(lockfile.packages[''].dependencies?.['kiwi-nlp']).toBe(KIWI_NLP_VERSION);
    expect(lockfile.packages['node_modules/kiwi-nlp']).toMatchObject({
      version: KIWI_NLP_VERSION,
      resolved: KIWI_NLP_PACKAGE_URL,
      integrity: KIWI_NLP_PACKAGE_INTEGRITY,
    });
    expect(packageJson.version).toBe(KIWI_NLP_VERSION);
    expect(wasmFixture).toHaveLength(KIWI_WASM_SIZE_BYTES);
    expect(sha256Hex(wasmFixture)).toBe(KIWI_WASM_SHA256);
  });

  it('rejects archives before extraction when size or digest differs', () => {
    expect(() => verifyKiwiNlpArchive(Buffer.alloc(1))).toThrow(/archive size mismatch/);
    expect(() => verifyKiwiNlpArchive(Buffer.alloc(KIWI_NLP_PACKAGE_SIZE_BYTES))).toThrow(/archive digest mismatch/);
  });

  it('extracts only the exact WASM entry within the decompression bound', async () => {
    const archive = createWasmArchive();

    const extracted = await extractKiwiWasm(archive);
    expect(extracted).toHaveLength(KIWI_WASM_SIZE_BYTES);
    expect(sha256Hex(extracted)).toBe(KIWI_WASM_SHA256);
    await expect(
      extractKiwiWasm(createWasmArchive('package/dist/not-kiwi.wasm', Buffer.from('wrong'))),
    ).rejects.toThrow(KIWI_WASM_TAR_ENTRY);
    await expect(extractKiwiWasm(archive, 1024)).rejects.toThrow(/exceeds maximum decompressed size/);
  });

  it('distinguishes absent, non-regular, and wrong-size payload states', () => {
    const { root, runtime } = createTestRuntime();
    try {
      expect(inspectKiwiWasmArtifact(runtime)).toMatchObject({
        installed: false,
        reason: 'file_missing',
      });

      mkdirSync(kiwiWasmPath(runtime), { recursive: true });
      expect(inspectKiwiWasmArtifact(runtime)).toMatchObject({
        installed: false,
        reason: 'file_not_regular',
      });

      rmSync(kiwiWasmPath(runtime), { recursive: true, force: true });
      writeFileSync(kiwiWasmPath(runtime), Buffer.alloc(1));
      expect(inspectKiwiWasmArtifact(runtime)).toMatchObject({
        installed: false,
        reason: 'file_size_mismatch',
      });

      writeFileSync(kiwiWasmPath(runtime), Buffer.alloc(KIWI_WASM_SIZE_BYTES + 1));
      expect(inspectKiwiWasmArtifact(runtime)).toMatchObject({
        installed: false,
        reason: 'file_size_mismatch',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('given a wrong-size payload, when publishing, then rejects before writing artifact files', () => {
    const { root, runtime } = createTestRuntime();
    try {
      expect(() => publishKiwiWasmArtifact(runtime, Buffer.alloc(1))).toThrow(/WASM size mismatch/);
      expect(runtime.storage.existsSync(kiwiWasmPath(runtime))).toBe(false);
      expect(runtime.storage.existsSync(kiwiWasmManifestPath(runtime))).toBe(false);
      expect(
        runtime.storage.existsSync(kiwiWasmDir(runtime)) &&
          readdirSync(kiwiWasmDir(runtime)).some((name) => name.endsWith('.tmp')),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('given a wrong-digest payload, when publishing, then rejects before writing artifact files', () => {
    const { root, runtime } = createTestRuntime();
    const corrupt = Buffer.from(wasmFixture);
    corrupt[corrupt.length - 1] ^= 0xff;
    try {
      expect(corrupt).toHaveLength(KIWI_WASM_SIZE_BYTES);
      expect(() => publishKiwiWasmArtifact(runtime, corrupt)).toThrow(/WASM digest mismatch/);
      expect(runtime.storage.existsSync(kiwiWasmPath(runtime))).toBe(false);
      expect(runtime.storage.existsSync(kiwiWasmManifestPath(runtime))).toBe(false);
      expect(
        runtime.storage.existsSync(kiwiWasmDir(runtime)) &&
          readdirSync(kiwiWasmDir(runtime)).some((name) => name.endsWith('.tmp')),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('publishes a strongly validated payload and manifest', () => {
    const { root, runtime } = createTestRuntime();
    try {
      const state = publishKiwiWasmArtifact(runtime, wasmFixture);

      expect(state.installed).toBe(true);
      expect(state.payloadSha256).toBe(KIWI_WASM_SHA256);
      expect(sha256Hex(readFileSync(kiwiWasmPath(runtime)))).toBe(KIWI_WASM_SHA256);
      expect(JSON.parse(readFileSync(kiwiWasmManifestPath(runtime), 'utf-8'))).toMatchObject({
        schemaVersion: 1,
        artifact: 'kiwi-wasm',
        kiwiNlpVersion: KIWI_NLP_VERSION,
        wasmSha256: KIWI_WASM_SHA256,
      });
      expect(readdirSync(kiwiWasmDir(runtime)).some((name) => name.endsWith('.tmp'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a same-size replacement whose digest changed', () => {
    const { root, runtime } = createTestRuntime();
    try {
      publishKiwiWasmArtifact(runtime, wasmFixture);
      const corrupt = Buffer.from(wasmFixture);
      corrupt[corrupt.length - 1] ^= 0xff;
      expect(runtime.storage.writeAtomicDurableSync(kiwiWasmPath(runtime), corrupt)).toBe(true);

      expect(inspectKiwiWasmArtifact(runtime)).toMatchObject({
        installed: false,
        payloadValid: false,
        reason: 'file_digest_mismatch',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rehashes a same-size in-place mutation even when its mtime is restored', () => {
    const { root, runtime } = createTestRuntime();
    const fixedTime = new Date('2026-01-01T00:00:00.000Z');
    try {
      publishKiwiWasmArtifact(runtime, wasmFixture);
      const path = kiwiWasmPath(runtime);
      utimesSync(path, fixedTime, fixedTime);
      expect(inspectKiwiWasmArtifact(runtime).installed).toBe(true);

      const descriptor = openSync(path, 'r+');
      try {
        writeSync(descriptor, Buffer.from([wasmFixture[0] ^ 0xff]), 0, 1, 0);
      } finally {
        closeSync(descriptor);
      }
      utimesSync(path, fixedTime, fixedTime);

      expect(statSync(path).mtimeMs).toBe(fixedTime.getTime());
      expect(inspectKiwiWasmArtifact(runtime)).toMatchObject({
        installed: false,
        payloadValid: false,
        reason: 'file_digest_mismatch',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'does not reuse readiness after the payload becomes unreadable',
    () => {
      const { root, runtime } = createTestRuntime();
      const path = kiwiWasmPath(runtime);
      try {
        publishKiwiWasmArtifact(runtime, wasmFixture);
        chmodSync(path, 0o000);

        expect(inspectKiwiWasmArtifact(runtime)).toMatchObject({
          installed: false,
          payloadValid: false,
          reason: 'file_unreadable',
        });

        chmodSync(path, 0o644);
        expect(inspectKiwiWasmArtifact(runtime).installed).toBe(true);
      } finally {
        try {
          chmodSync(path, 0o644);
        } catch {
          // The fixture may already have been removed after an assertion failure.
        }
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('passes the pinned archive byte limit to the downloader before buffering', async () => {
    const { root, runtime } = createTestRuntime();
    const download = vi.fn(async (_runtime, url: string, options: { readonly maxBytes: number }) => {
      expect(url).toBe(KIWI_NLP_PACKAGE_URL);
      expect(options.maxBytes).toBe(KIWI_NLP_PACKAGE_SIZE_BYTES);
      throw new Error('stop after bound assertion');
    });
    try {
      await expect(ensureKiwiWasmArtifactLocked(runtime, { download })).rejects.toThrow('stop after bound assertion');
      expect(download).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('repairs a directory occupying the canonical WASM file path', () => {
    const { root, runtime } = createTestRuntime();
    try {
      mkdirSync(kiwiWasmPath(runtime), { recursive: true });

      const state = publishKiwiWasmArtifact(runtime, wasmFixture);

      expect(state.installed).toBe(true);
      expect(statSync(kiwiWasmPath(runtime)).isFile()).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('repairs a directory occupying the manifest path without downloading again', async () => {
    const { root, runtime } = createTestRuntime();
    try {
      publishKiwiWasmArtifact(runtime, wasmFixture);
      rmSync(kiwiWasmManifestPath(runtime), { force: true });
      mkdirSync(kiwiWasmManifestPath(runtime), { recursive: true });
      const download = vi.fn();

      const state = await ensureKiwiWasmArtifactLocked(runtime, { download });

      expect(state.installed).toBe(true);
      expect(statSync(kiwiWasmManifestPath(runtime)).isFile()).toBe(true);
      expect(download).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when durable payload publication fails and leaves no manifest or temp file', () => {
    const { root, runtime } = createTestRuntime();
    const writeAtomicDurableSync = runtime.storage.writeAtomicDurableSync;
    const writeSpy = vi.spyOn(runtime.storage, 'writeAtomicDurableSync');
    try {
      writeSpy.mockImplementation((path, data, options) =>
        path === kiwiWasmPath(runtime) ? false : writeAtomicDurableSync(path, data, options),
      );

      expect(() => publishKiwiWasmArtifact(runtime, wasmFixture)).toThrow(/could not be published durably/);
      expect(runtime.storage.existsSync(kiwiWasmManifestPath(runtime))).toBe(false);
      expect(readdirSync(kiwiWasmDir(runtime)).some((name) => name.endsWith('.tmp'))).toBe(false);
    } finally {
      writeSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('recovers a file-before-manifest interruption without downloading again', async () => {
    const { root, runtime } = createTestRuntime();
    const writeAtomicDurableSync = runtime.storage.writeAtomicDurableSync;
    const writeSpy = vi.spyOn(runtime.storage, 'writeAtomicDurableSync');
    try {
      writeSpy.mockImplementation((path, data, options) => {
        if (path === kiwiWasmManifestPath(runtime)) {
          return false;
        }
        return writeAtomicDurableSync(path, data, options);
      });

      expect(() => publishKiwiWasmArtifact(runtime, wasmFixture)).toThrow(/manifest could not be published/);
      expect(inspectKiwiWasmArtifact(runtime)).toMatchObject({
        installed: false,
        payloadValid: true,
        reason: 'manifest_missing_or_invalid',
      });
      expect(readdirSync(kiwiWasmDir(runtime)).some((name) => name.endsWith('.tmp'))).toBe(false);

      writeSpy.mockRestore();
      const download = vi.fn();
      const recovered = await ensureKiwiWasmArtifactLocked(runtime, { download });

      expect(recovered.installed).toBe(true);
      expect(download).not.toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
