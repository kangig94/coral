import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { JobConversation } from '#src/jobs/conversation/entry.js';
import {
  archiveProviderArtifactsForJob,
  conversationArchiveDirectory,
  deriveProviderArtifactActionDescriptor,
  publishConversationRestore,
  restoreStagePath,
  verifyConversationRestore,
} from '#src/jobs/conversation/provider-artifact-archive.js';
import { TEST_CODEX_BINDING } from '#tests/helpers/provider-credentials.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { EXECUTION_JOB_ID as jobId } from '#tests/helpers/job-executions.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

const native = '/home/user/.codex/sessions/2026/10/22/rollout-thread.jsonl';
const bytes = Buffer.from([0x00, 0xff, 0xc0, 0x80, 0x0d, 0x0a, 0xe2, 0x82, 0xac]);
const sha256 = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
function fixture() {
  const runtime = new SimulationRuntime();
  runtime.storage.mkdirSync(dirname(native), { recursive: true });
  runtime.storage.writeFileSync(native, bytes);
  const conversation: JobConversation = {
    jobId,
    execution: 1,
    provider: 'codex',
    binding: TEST_CODEX_BINDING,
    name: 'archive',
    cwd: fixtureCanonicalWorkDir('/workspace'),
    projectRoot: '/workspace',
    backendNamespace: 'tests',
    bypassPermissions: false,
    retention: 'discard_provider_artifacts_on_terminal',
    open: false,
    finishing: false,
    artifactHandles: [],
    retentionDiscard: { attempts: [] },
    providerContinuity: null,
    conversationRef: 'thread',
    createdAt: '2026-10-22T00:00:00.000Z',
    lastUsedAt: '2026-10-22T00:00:00.000Z',
  };
  const directory = conversationArchiveDirectory(runtime, jobId);
  const manifestPath = join(directory, 'manifest.json');
  const manifest = () =>
    JSON.parse(runtime.storage.readFileSync(manifestPath, 'utf-8')) as {
      execution: number;
      archiveActionId: string;
      canonicalHandles: { handle: string }[];
      artifacts: {
        archivePath: string;
        sourceHandle: string;
        bytes: number;
        sourceSha256: string;
        archiveSha256: string;
      }[];
    };
  const descriptor = (execution: number) =>
    deriveProviderArtifactActionDescriptor({
      entry: { ...conversation, execution },
      jobId,
      handles: [native],
      sourceRevision: `accepted-${execution}`,
      archivedAt: conversation.createdAt,
    });
  const archive = (execution = 1) => archiveProviderArtifactsForJob({ runtime, descriptor: descriptor(execution) });
  const verify = (minimumExecution = 1) =>
    verifyConversationRestore({ runtime, conversation, nativeHandle: native, minimumExecution });
  return { runtime, conversation, directory, manifestPath, manifest, descriptor, archive, verify };
}

describe('one committed conversation archive', () => {
  it('retains binary bytes and replaces an already populated archive twice', async () => {
    const f = fixture();
    for (const execution of [1, 2, 3]) {
      const content = Buffer.concat([bytes, Buffer.from([execution])]);
      f.runtime.storage.writeFileSync(native, content);
      await f.archive(execution);
      const manifest = f.manifest();
      expect(manifest.execution).toBe(execution);
      expect(manifest.artifacts[0]).toMatchObject({
        sourceHandle: native,
        bytes: content.length,
        sourceSha256: sha256(content),
        archiveSha256: sha256(content),
      });
      expect(f.runtime.storage.readFileBytesSync(join(f.directory, manifest.artifacts[0].archivePath))).toEqual(
        content,
      );
      expect(f.runtime.storage.readdirSync(f.directory).sort()).toEqual(
        [manifest.artifacts[0].archivePath, 'manifest.json'].sort(),
      );
    }
    expect(
      f.runtime.storage.existsSync(join(f.runtime.paths.coral.exports.jobsRoot, jobId, 'provider-artifacts')),
    ).toBe(false);
  });

  it.each([
    'before bytes',
    'byte sync',
    'after bytes',
    'before manifest',
    'after manifest',
    'manifest sync',
    'old blob cleanup',
  ])('recovers a crash at %s with the old or new complete manifest', async (boundary) => {
    const f = fixture();
    await f.archive();
    const old = f.manifest();
    const next = Buffer.concat([bytes, Buffer.from('next')]);
    f.runtime.storage.writeFileSync(native, next);
    const write = f.runtime.storage.writeAtomicDurableSync.bind(f.runtime.storage);
    const unlink = f.runtime.storage.unlinkSync.bind(f.runtime.storage);
    let crashed = false;
    const byteSync =
      boundary === 'byte sync'
        ? vi.spyOn(f.runtime.storage, 'fdatasyncSync').mockImplementation(() => {
            crashed = true;
            throw new Error('crash');
          })
        : null;
    const publication = vi
      .spyOn(f.runtime.storage, 'writeAtomicDurableSync')
      .mockImplementation((path, data, options) => {
        const manifest = path === f.manifestPath;
        if (!crashed && ((boundary === 'before bytes' && !manifest) || (boundary === 'before manifest' && manifest))) {
          crashed = true;
          throw new Error('crash');
        }
        const result = write(path, data, options);
        if (!crashed && ((boundary === 'after bytes' && !manifest) || (boundary === 'after manifest' && manifest))) {
          crashed = true;
          throw new Error('crash');
        }
        if (!crashed && boundary === 'manifest sync' && manifest) {
          crashed = true;
          return false;
        }
        return result;
      });
    const cleanup = vi.spyOn(f.runtime.storage, 'unlinkSync').mockImplementation((path) => {
      if (!crashed && boundary === 'old blob cleanup' && path === join(f.directory, old.artifacts[0].archivePath)) {
        crashed = true;
        throw new Error('crash');
      }
      unlink(path);
    });
    await expect(f.archive(2)).rejects.toThrow();
    expect(crashed).toBe(true);
    expect(f.runtime.storage.readFileBytesSync(native)).toEqual(next);
    const committed = f.manifest();
    const expected = ['after manifest', 'manifest sync', 'old blob cleanup'].includes(boundary) ? next : bytes;
    expect(f.runtime.storage.readFileBytesSync(join(f.directory, committed.artifacts[0].archivePath))).toEqual(
      expected,
    );
    expect(committed.artifacts[0].sourceSha256).toBe(sha256(expected));
    publication.mockRestore();
    cleanup.mockRestore();
    byteSync?.mockRestore();
    await f.archive(2);
    expect(f.manifest().execution).toBe(2);
    expect(f.runtime.storage.readdirSync(f.directory)).toHaveLength(2);
  });

  it('does not adopt the previous execution archive when newer native bytes are absent', async () => {
    const f = fixture();
    await f.archive();
    f.runtime.storage.unlinkSync(native);
    expect(await f.verify(2)).toMatchObject({ kind: 'unrestorable', reason: 'archive_stale' });
    await f.archive(2);
    expect(f.manifest().execution).toBe(1);
    expect(await f.verify(2)).toMatchObject({ kind: 'unrestorable', reason: 'archive_stale' });
  });

  it('makes failed initial publication unusable and keeps the native file', async () => {
    const f = fixture();
    vi.spyOn(f.runtime.storage, 'writeAtomicDurableSync').mockReturnValue(false);
    await expect(f.archive()).rejects.toThrow();
    expect(f.runtime.storage.readFileBytesSync(native)).toEqual(bytes);
    expect(f.runtime.storage.existsSync(f.manifestPath)).toBe(false);
  });
});

describe('read-only verification and no-replace restore', () => {
  it('verifies without creating the destination, then publishes complete exact bytes', async () => {
    const f = fixture();
    await f.archive();
    f.runtime.storage.rmSync('/home/user/.codex/sessions', { recursive: true });
    const verification = await f.verify();
    expect(verification).toMatchObject({ kind: 'verified', sourceSha256: sha256(bytes) });
    expect(restoreStagePath(native, jobId, 2)).not.toMatch(/rollout-.*\.jsonl$|\.jsonl$/);
    expect(f.runtime.storage.existsSync(dirname(native))).toBe(false);
    const sync = vi.spyOn(f.runtime.storage, 'syncDirectoryDurableSync');
    const result = await publishConversationRestore({ runtime: f.runtime, jobId, execution: 2, verification });
    expect(result).toEqual({ kind: 'restored', sourceHandle: native, sourceSha256: sha256(bytes) });
    expect(f.runtime.storage.readFileBytesSync(native)).toEqual(bytes);
    for (const directory of [
      '/home/user/.codex/sessions',
      '/home/user/.codex/sessions/2026',
      '/home/user/.codex/sessions/2026/10',
      dirname(native),
    ])
      expect(sync).toHaveBeenCalledWith(directory);
    expect(f.runtime.storage.existsSync(restoreStagePath(native, jobId, 2))).toBe(false);
  });

  it('reports present without reading or hashing existing native bytes', async () => {
    const f = fixture();
    const read = vi.spyOn(f.runtime.storage, 'readFileBytesSync');
    expect(await f.verify()).toEqual({ kind: 'present', sourceHandle: native });
    expect(read).not.toHaveBeenCalled();
  });

  it.each(['before publication', 'at link'])('preserves a destination created %s', async (boundary) => {
    const f = fixture();
    await f.archive();
    f.runtime.storage.unlinkSync(native);
    const verification = await f.verify();
    const created = Buffer.from('created by another writer');
    if (boundary === 'before publication') f.runtime.storage.writeFileSync(native, created);
    else {
      const link = f.runtime.storage.linkSync.bind(f.runtime.storage);
      vi.spyOn(f.runtime.storage, 'linkSync').mockImplementation((stage, destination) => {
        f.runtime.storage.writeFileSync(destination, created);
        link(stage, destination);
      });
    }
    const result = await publishConversationRestore({ runtime: f.runtime, jobId, execution: 2, verification });
    expect(result).toEqual({ kind: 'present', sourceHandle: native });
    expect(result).not.toHaveProperty('sourceSha256');
    expect(f.runtime.storage.readFileBytesSync(native)).toEqual(created);
    expect(f.runtime.storage.existsSync(restoreStagePath(native, jobId, 2))).toBe(false);
  });

  it.each(['before stage sync', 'before link', 'after link', 'directory sync', 'stage unlink'])(
    'returns typed unrestorable and recovers a crash at %s',
    async (boundary) => {
      const f = fixture();
      await f.archive();
      f.runtime.storage.unlinkSync(native);
      const verification = await f.verify();
      const stage = restoreStagePath(native, jobId, 2);
      const link = f.runtime.storage.linkSync.bind(f.runtime.storage);
      const sync = f.runtime.storage.syncDirectoryDurableSync.bind(f.runtime.storage);
      const unlink = f.runtime.storage.unlinkSync.bind(f.runtime.storage);
      let linked = false;
      const mocks = [
        vi.spyOn(f.runtime.storage, 'linkSync').mockImplementation((source, destination) => {
          if (boundary === 'before link') throw new Error('crash');
          link(source, destination);
          linked = true;
          if (boundary === 'after link') throw new Error('crash');
        }),
        vi
          .spyOn(f.runtime.storage, 'syncDirectoryDurableSync')
          .mockImplementation((path) => (boundary === 'directory sync' && linked ? false : sync(path))),
        vi.spyOn(f.runtime.storage, 'unlinkSync').mockImplementation((path) => {
          if (boundary === 'stage unlink' && linked && path === stage) throw new Error('crash');
          unlink(path);
        }),
      ];
      const stageSync =
        boundary === 'before stage sync'
          ? vi.spyOn(f.runtime.storage, 'fdatasyncSync').mockImplementation(() => {
              throw new Error('crash');
            })
          : null;
      expect(await publishConversationRestore({ runtime: f.runtime, jobId, execution: 2, verification })).toMatchObject(
        { kind: 'unrestorable', reason: 'publication_failed' },
      );
      mocks.forEach((mock) => mock.mockRestore());
      stageSync?.mockRestore();
      await f.archive(2);
      expect(f.runtime.storage.existsSync(stage)).toBe(false);
      if (linked) {
        expect(f.manifest().execution).toBe(2);
        expect(f.runtime.storage.readFileBytesSync(native)).toEqual(bytes);
      } else expect(f.runtime.storage.existsSync(native)).toBe(false);
    },
  );

  it('rejects tampered archive bytes, invalid manifests and out-of-profile native paths', async () => {
    const f = fixture();
    await f.archive();
    f.runtime.storage.unlinkSync(native);
    const manifest = f.manifest();
    f.runtime.storage.writeFileSync(join(f.directory, manifest.artifacts[0].archivePath), 'corrupt');
    expect(await f.verify()).toMatchObject({ kind: 'unrestorable', reason: 'archive_invalid' });
    manifest.artifacts[0].sourceHandle = '/outside/native.jsonl';
    manifest.canonicalHandles[0].handle = '/outside/native.jsonl';
    f.runtime.storage.writeFileSync(f.manifestPath, JSON.stringify(manifest));
    expect(await f.verify()).toMatchObject({ kind: 'unrestorable', reason: 'profile_mismatch' });
    f.runtime.storage.writeFileSync(f.manifestPath, '{}');
    expect(await f.verify()).toMatchObject({ kind: 'unrestorable', reason: 'archive_invalid' });
  });
});
