import { createRequire } from 'node:module';
import { sharedFixture } from '#tests/helpers/shared-fixtures.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { decodeSerializedWaitCursor } from '#src/jobs/wait/cursor.js';
import { jobsWaitRequest, jobWaitSchema } from '#src/transport/rpc/jobs.js';
import type { WaitCursor } from '#src/jobs/wait/contract.js';
import type { z } from 'zod';

const directory = mkdtempSync(join(tmpdir(), 'coral-released-wait-cursor-'));
const releases = ['v0.10.15', 'v0.10.16', 'v0.10.17', 'v0.10.18'];
const contracts = new Map<
  string,
  {
    serializeWaitCursor(cursor: WaitCursor): string;
    parseSerializedWaitCursor(raw: string): WaitCursor | null;
    jobWaitSchema: z.ZodType;
  }
>();

beforeAll(() => {
  for (const tag of releases) contracts.set(tag, createRequire(import.meta.url)(sharedFixture(tag)));
});

afterAll(() => rmSync(directory, { recursive: true, force: true }));

const legacy: WaitCursor = { afterSeq: 42, deliveredJobIds: ['known'] };
const vector: WaitCursor = {
  version: 'jobs.wait.v2',
  positions: { '/source:lineage:epoch:7': 42 },
  locations: { known: '/source:lineage:epoch:7', pending: '/source:lineage:epoch:7' },
  deliveredJobIds: ['known'],
};

it.each(releases)('%s printed cursors decode without changing their frontiers', (release) => {
  const contract = contracts.get(release);
  if (contract === undefined) throw new Error('Missing released contract');
  for (const cursor of release === 'v0.10.15' ? [legacy] : [legacy, vector]) {
    const printed = contract.serializeWaitCursor(cursor);
    expect(contract.parseSerializedWaitCursor(printed)).toEqual(cursor);
    expect(decodeSerializedWaitCursor(printed)).toEqual({ kind: 'decoded', cursor });
    expect(jobWaitSchema.safeParse({ jobIds: ['known', 'pending'], projectRoot: '/tmp', cursor }).success).toBe(true);
  }
});

it.each(releases)('new CLI carriage parses through the actual %s request contract', (release) => {
  const contract = contracts.get(release);
  if (contract === undefined) throw new Error('Missing released contract');
  const extensions =
    release === 'v0.10.15' ? ['supportsInterrupted'] : ['supportsInterrupted', 'supportsWaitV2', 'supportsHandover'];
  for (const cursor of [legacy, vector]) {
    const reset = vi.fn();
    const request = jobsWaitRequest({ jobIds: ['known', 'pending'], projectRoot: '/tmp', cursor }, extensions, reset);
    expect(contract.jobWaitSchema.safeParse(request).success).toBe(true);
    if (release === 'v0.10.15' && cursor === vector) {
      expect(request).not.toHaveProperty('cursor');
      expect(reset).toHaveBeenCalledOnce();
    } else {
      expect(request.cursor).toBe(cursor);
      expect(reset).not.toHaveBeenCalled();
    }
  }
});
