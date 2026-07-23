import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { StrictBundleManifest } from '#src/infra/bundle-manifest.js';
import { listStoreResetIncidents, StoreResetIncidentLimitError } from '#src/store/reset-incident-reader.js';
import type {
  StoreResetDirectoryCursor,
  StoreResetFileDescriptor,
  StoreResetInspectionFs,
  StoreResetInspectionStat,
} from '#src/store/reset-incident-inspection-fs.js';
import {
  MAX_INCIDENT_ROOT_ENTRIES,
  serializeStoreResetIncidentManifest,
  type StoreResetIncidentManifestV2,
} from '#src/store/reset-incident.js';

const ROOT = '/coral/store/store-reset-quarantine';
const BUILD: StrictBundleManifest = {
  version: '0.9.16',
  buildSetId: '123e4567-e89b-42d3-a456-426614174000',
  bundleHash: '0123456789abcdef',
  flavor: 'prod',
  storeFormatFingerprint: `sha256:${'f'.repeat(64)}`,
};

type Cursor = { readonly entries: readonly string[]; offset: number };
type Descriptor = { readonly path: string };

function stat(kind: StoreResetInspectionStat['kind'], size = 0): StoreResetInspectionStat {
  return {
    dev: 1n,
    ino: BigInt(size + 1),
    size: BigInt(size),
    mtimeNs: 123n,
    mode: kind === 'directory' ? 0o40700n : 0o100600n,
    kind,
  };
}

class MemoryInspectionFs implements StoreResetInspectionFs {
  readonly openFlags = { readOnly: 0, createExclusiveWrite: 1 };
  readonly entries = new Map<string, string[]>();
  readonly files = new Map<string, Uint8Array>();
  readonly stats = new Map<string, StoreResetInspectionStat>();
  closeDirectoryFails = false;

  lstat(path: string): StoreResetInspectionStat | null {
    return this.stats.get(path) ?? null;
  }

  fstat(descriptor: StoreResetFileDescriptor): StoreResetInspectionStat {
    const path = (descriptor as Descriptor).path;
    const value = this.stats.get(path);
    if (value === undefined) throw new Error('missing');
    return value;
  }

  realpath(path: string): string {
    return path;
  }

  openDirectory(path: string): StoreResetDirectoryCursor {
    return { entries: this.entries.get(path) ?? [], offset: 0 } satisfies Cursor;
  }

  readDirectory(cursor: StoreResetDirectoryCursor) {
    const value = cursor as Cursor;
    const name = value.entries[value.offset];
    value.offset += 1;
    return name === undefined ? null : { name };
  }

  closeDirectory(_cursor: StoreResetDirectoryCursor): void {
    if (this.closeDirectoryFails) throw new Error('close sentinel');
  }

  open(path: string, _flags: number, _mode?: number): StoreResetFileDescriptor {
    if (!this.files.has(path)) throw new Error('missing');
    return { path } satisfies Descriptor;
  }

  read(
    descriptor: StoreResetFileDescriptor,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): number {
    const source = this.files.get((descriptor as Descriptor).path);
    if (source === undefined) throw new Error('missing');
    const available = Math.max(0, Math.min(length, source.length - position));
    buffer.set(source.subarray(position, position + available), offset);
    return available;
  }

  write(): number {
    throw new Error('unused');
  }

  close(_descriptor: StoreResetFileDescriptor): void {}

  mkdtemp(): string {
    throw new Error('unused');
  }

  removeTreeGuarded(): boolean {
    throw new Error('unused');
  }

  addRoot(entries: readonly string[]): void {
    this.stats.set(ROOT, stat('directory'));
    this.entries.set(ROOT, [...entries]);
  }

  addIncident(id: string, value: StoreResetIncidentManifestV2 | string): void {
    const directory = join(ROOT, id);
    const manifestPath = join(directory, 'reset-manifest.json');
    const contents = new TextEncoder().encode(
      typeof value === 'string' ? value : serializeStoreResetIncidentManifest(value),
    );
    this.stats.set(directory, stat('directory'));
    this.stats.set(manifestPath, stat('file', contents.length));
    this.files.set(manifestPath, contents);
  }
}

function manifest(id: string, resetAt: string, build: StrictBundleManifest = BUILD): StoreResetIncidentManifestV2 {
  return {
    schemaVersion: 2,
    incidentId: id,
    resetAt,
    reason: 'mismatch',
    storedFingerprint: `sha256:${'a'.repeat(64)}`,
    expectedFingerprint: build.storeFormatFingerprint,
    build: {
      version: build.version,
      buildSetId: build.buildSetId,
      backendBundleHash: build.bundleHash,
      flavor: build.flavor,
    },
    runtime: {
      namespace: 'test',
      nodeVersion: 'v24.7.0',
      platform: 'linux',
      architecture: 'x64',
      processId: 42,
    },
    handoff: { acquiredViaHandoff: false },
    files: [
      {
        name: 'store.db',
        sizeBytes: 1,
        mtimeMs: 1,
        sha256: 'b'.repeat(64),
      },
    ],
  };
}

describe('store reset incident listing', () => {
  it('treats a missing root as an empty local success', () => {
    const fs = new MemoryInspectionFs();
    expect(listStoreResetIncidents({ fs, quarantineRoot: ROOT, expectedBuild: BUILD })).toEqual({
      incidents: [],
    });
  });

  it('streams only through the root cap plus one and rejects overflow', () => {
    const fs = new MemoryInspectionFs();
    fs.addRoot(Array.from({ length: MAX_INCIDENT_ROOT_ENTRIES + 1 }, (_, index) => `ignored-${index}`));

    expect(() => listStoreResetIncidents({ fs, quarantineRoot: ROOT, expectedBuild: BUILD })).toThrow(
      StoreResetIncidentLimitError,
    );
  });

  it('sorts current-build incidents newest-first and ignores non-UUID staging entries', () => {
    const older = '123e4567-e89b-42d3-a456-426614174000';
    const newer = '223e4567-e89b-42d3-a456-426614174000';
    const fs = new MemoryInspectionFs();
    fs.addRoot([older, `${newer}.tmp`, newer]);
    fs.addIncident(older, manifest(older, '2026-07-22T01:02:03.004Z'));
    fs.addIncident(newer, manifest(newer, '2026-07-23T01:02:03.004Z'));

    expect(listStoreResetIncidents({ fs, quarantineRoot: ROOT, expectedBuild: BUILD }).incidents).toEqual([
      {
        incidentId: newer,
        state: 'ready',
        resetAt: '2026-07-23T01:02:03.004Z',
        reason: 'mismatch',
        fileCount: 1,
      },
      {
        incidentId: older,
        state: 'ready',
        resetAt: '2026-07-22T01:02:03.004Z',
        reason: 'mismatch',
        fileCount: 1,
      },
    ]);
  });

  it('returns only fixed states for malformed and mixed-build incidents', () => {
    const malformed = '123e4567-e89b-42d3-a456-426614174000';
    const mixed = '223e4567-e89b-42d3-a456-426614174000';
    const fs = new MemoryInspectionFs();
    fs.addRoot([malformed, mixed]);
    fs.addIncident(malformed, '{not-json');
    fs.addIncident(
      mixed,
      manifest(mixed, '2026-07-23T01:02:03.004Z', {
        ...BUILD,
        buildSetId: '323e4567-e89b-42d3-a456-426614174000',
      }),
    );

    expect(listStoreResetIncidents({ fs, quarantineRoot: ROOT, expectedBuild: BUILD }).incidents).toEqual([
      {
        incidentId: malformed,
        state: 'malformed',
        resetAt: null,
        reason: null,
        fileCount: null,
      },
      {
        incidentId: mixed,
        state: 'build_mismatch',
        resetAt: null,
        reason: null,
        fileCount: null,
      },
    ]);
  });

  it('fails closed when the bounded directory cursor cannot close', () => {
    const fs = new MemoryInspectionFs();
    fs.addRoot([]);
    fs.closeDirectoryFails = true;

    expect(() => listStoreResetIncidents({ fs, quarantineRoot: ROOT, expectedBuild: BUILD })).toThrow(
      'Store reset incident could not be read safely.',
    );
  });
});
