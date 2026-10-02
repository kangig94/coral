import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { testChildPrincipalRegistry } from '#tests/helpers/child-principal-registry.js';
import { WorkDirectoryError } from '#src/runtime/canonical-work-dir.js';
import { decodeProviderOperationRecord, encodeProviderOperationRecord } from '#src/store/provider-operation-record.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';

const tempDirs: string[] = [];

function ids() {
  return { randomBytes: (length: number) => Buffer.alloc(length, 1) };
}

function persistedAuthorization(root: string) {
  const base = providerOperationRecord('prepare-pending');
  if (base.phase !== 'prepare-pending') throw new Error('Expected a prepare-pending provider operation fixture.');
  const encoded = encodeProviderOperationRecord({
    ...base,
    prepareSource: {
      ...base.prepareSource,
      childAuthorization: {
        ...base.prepareSource.childAuthorization,
        principalWire: {
          ...base.prepareSource.childAuthorization.principalWire,
          binding: { kind: 'project', root },
        },
      },
    },
  });
  const recovered = decodeProviderOperationRecord(encoded);
  if (recovered.phase !== 'prepare-pending') throw new Error('Expected a recovered prepare-pending operation.');
  return recovered.prepareSource.childAuthorization;
}

afterEach(() => {
  for (const root of tempDirs.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('canonical work-directory carrier closure', () => {
  it('canonicalizes a persisted symlink binding before registering the recovered principal', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'coral-persisted-principal-'));
    tempDirs.push(root);
    const physical = resolve(root, 'physical');
    const selected = resolve(root, 'selected');
    mkdirSync(physical);
    symlinkSync(physical, selected, 'dir');
    const registry = testChildPrincipalRegistry(ids());

    const credential = registry.registerPersistedAuthorization({
      issuer: 'provider-operation-recovery',
      authorization: persistedAuthorization(selected),
      parentJobId: 'job-a',
      parentSessionId: 'session-a',
      nowMs: 1,
    });

    expect(credential.authorization.principalWire.binding).toEqual({
      kind: 'project',
      root: realpathSync(physical),
    });
  });

  it('refuses a missing persisted binding when registering the recovered principal', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'coral-missing-persisted-principal-'));
    tempDirs.push(root);
    const missing = resolve(root, 'missing');
    const registry = testChildPrincipalRegistry(ids());

    expect(() =>
      registry.registerPersistedAuthorization({
        issuer: 'provider-operation-recovery',
        authorization: persistedAuthorization(missing),
        parentJobId: 'job-a',
        parentSessionId: 'session-a',
        nowMs: 1,
      }),
    ).toThrow(WorkDirectoryError);
  });
});
