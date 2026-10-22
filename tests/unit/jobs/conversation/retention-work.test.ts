import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  archiveProviderArtifactsForJob,
  conversationArchiveDirectory,
  deriveProviderArtifactActionDescriptor,
} from '#src/jobs/conversation/provider-artifact-archive.js';
import { ProviderArtifactProtocolInvariantError } from '#src/providers/contract.js';
import { EXECUTION_JOB_ID } from '#tests/helpers/job-executions.js';
import { conversationRetentionHarness } from '#tests/helpers/conversation-retention.js';

const harnesses: ReturnType<typeof conversationRetentionHarness>[] = [];
function harness(options: Parameters<typeof conversationRetentionHarness>[0] = {}) {
  const h = conversationRetentionHarness(options);
  harnesses.push(h);
  return h;
}
afterEach(async () => {
  for (const h of harnesses) await h.close();
  harnesses.length = 0;
  vi.restoreAllMocks();
});

const manifestSchema = z
  .object({
    archiveActionId: z.string(),
    archivedAt: z.string(),
    artifacts: z.array(z.object({ status: z.string(), archivePath: z.string().optional() }).passthrough()),
  })
  .passthrough();
function manifest(h: ReturnType<typeof harness>) {
  return manifestSchema.parse(JSON.parse(h.runtime.storage.readFileSync(h.manifestPath(), 'utf-8')));
}
async function seed(h: ReturnType<typeof harness>, handle = '/tmp/provider/artifact.jsonl') {
  h.start();
  await h.recordArtifact(handle);
  h.accept();
  const action = await h.request();
  return { handle, action, address: { jobId: EXECUTION_JOB_ID, execution: 1 } };
}

describe('job conversation retention work', () => {
  it('rejects a corrupted foreign archive before provider discard without downgrading its record', async () => {
    const h = harness();
    const { handle, action, address } = await seed(h);
    const descriptor = h.descriptor();
    const foreign = deriveProviderArtifactActionDescriptor({
      entry: h.read(),
      jobId: EXECUTION_JOB_ID,
      handles: [handle],
      sourceRevision: 'foreign-archive-revision',
      archivedAt: descriptor.archivedAt,
    });
    await archiveProviderArtifactsForJob({ runtime: h.runtime, descriptor: foreign });
    const before = manifest(h);
    const archived = before.artifacts[0]?.archivePath;
    if (archived === undefined) throw new Error('Expected archived fixture.');
    h.runtime.storage.writeFileSync(
      join(conversationArchiveDirectory(h.runtime, EXECUTION_JOB_ID), archived),
      'corrupted archive\n',
      { encoding: 'utf-8' },
    );
    h.runtime.storage.unlinkSync(handle);
    await expect(h.reactor.settleRetention(address, action)).resolves.toMatchObject({
      kind: 'failed',
      reason: expect.stringContaining('Archive failed'),
    });
    expect(h.capabilityCalls).toEqual([]);
    expect(h.providerEffects).toEqual([]);
    expect(manifest(h)).toEqual(before);
  });

  it('restarts after archive publication with the exact action ids and stable archivedAt', async () => {
    const h = harness();
    const { action, address } = await seed(h);
    const descriptor = h.descriptor();
    await archiveProviderArtifactsForJob({ runtime: h.runtime, descriptor });
    const published = manifest(h);
    h.restart();
    await h.reactor.scanStartup(h.lifetime.signal);
    expect(h.providerEffects).toEqual([]);
    await expect(h.reactor.settleRetention(address, action)).resolves.toEqual({
      kind: 'completed',
      outcome: 'discarded',
    });
    expect(h.capabilityCalls.find((call) => call.kind === 'discard')?.actionId).toBe(descriptor.discardActionId);
    expect(manifest(h)).toEqual(published);
    expect(manifest(h).archivedAt).toBe(descriptor.archivedAt);
    await expect(h.reactor.settleRetention(address, action)).resolves.toEqual({
      kind: 'completed',
      outcome: 'discarded',
    });
    expect(h.providerEffects).toHaveLength(1);
  });

  it('reconciles after native discard before replay and does not double-discard', async () => {
    const h = harness();
    const { handle, action, address } = await seed(h);
    h.db.exec(`
      CREATE TRIGGER crash_after_native_discard BEFORE UPDATE ON recovery_quarantine
      WHEN NEW.boundary_id = 'job-conversation-retention'
        AND json_extract(NEW.continuation_key, '$.kind') = 'completed'
      BEGIN SELECT RAISE(ABORT, 'fixture crash before outcome checkpoint'); END;
    `);
    await expect(h.reactor.settleRetention(address, action)).rejects.toThrow('fixture crash before outcome checkpoint');
    expect(h.runtime.storage.existsSync(handle)).toBe(false);
    expect(h.providerEffects).toHaveLength(1);
    h.db.exec('DROP TRIGGER crash_after_native_discard');
    h.restart();
    await expect(h.reactor.settleRetention(address, action)).resolves.toEqual({
      kind: 'completed',
      outcome: 'discarded',
    });
    expect(h.providerEffects).toHaveLength(1);
  });

  it('fails closed on a verified archive hash conflict before provider effect', async () => {
    const h = harness();
    const { action, address } = await seed(h);
    await archiveProviderArtifactsForJob({ runtime: h.runtime, descriptor: h.descriptor() });
    const archived = manifest(h).artifacts[0]?.archivePath;
    if (archived === undefined) throw new Error('Expected archived fixture.');
    h.runtime.storage.writeFileSync(join(dirname(h.manifestPath()), archived), 'tampered archive\n', {
      encoding: 'utf-8',
    });
    await expect(h.reactor.settleRetention(address, action)).resolves.toMatchObject({
      kind: 'failed',
      reason: expect.stringContaining('Archive failed'),
    });
    expect(h.capabilityCalls).toEqual([]);
    expect(h.providerEffects).toEqual([]);
  });

  it('rejects a changed provider payload under one action id before another provider effect', async () => {
    const h = harness();
    const { action, address } = await seed(h);
    await h.reactor.settleRetention(address, action);
    const actionId = h.capabilityCalls.find((call) => call.kind === 'discard')?.actionId;
    if (actionId === undefined) throw new Error('Expected provider discard action.');
    const file = createHash('sha256').update(actionId, 'utf-8').digest('hex');
    const path = join(h.runtime.paths.coral.exports.jobsRoot, '.provider-artifact-discard.v2', `${file}.json`);
    const record = z.record(z.unknown()).parse(JSON.parse(h.runtime.storage.readFileSync(path, 'utf-8')));
    h.runtime.storage.writeFileSync(path, `${JSON.stringify({ ...record, payloadHash: 'conflict' })}\n`, {
      encoding: 'utf-8',
    });
    h.db.prepare("DELETE FROM recovery_quarantine WHERE boundary_id = 'job-conversation-retention'").run();
    h.restart();
    await expect(h.reactor.settleRetention(address, action)).rejects.toBeInstanceOf(
      ProviderArtifactProtocolInvariantError,
    );
    expect(h.providerEffects).toHaveLength(1);
  });
});
