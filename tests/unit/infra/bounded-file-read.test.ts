import { describe, expect, it } from 'vitest';

import {
  readBoundedFileAtIdentity,
  sameFileIdentity,
  type BoundedFileReadStorage,
} from '#src/infra/bounded-file-read.js';
import type { StorageBigIntStat } from '#src/infra/port-types.js';

function fakeStat(overrides: Partial<StorageBigIntStat> = {}): StorageBigIntStat {
  return {
    dev: 1n,
    ino: 2n,
    mode: 0o100600n,
    uid: 1000n,
    size: 4n,
    mtimeNs: 100n,
    isDirectory: () => false,
    isFile: () => true,
    ...overrides,
  };
}

describe('sameFileIdentity', () => {
  it('is true only when device, inode, mode, uid, size, and mtime all agree', () => {
    expect(sameFileIdentity(fakeStat(), fakeStat())).toBe(true);
    expect(sameFileIdentity(fakeStat(), fakeStat({ dev: 2n }))).toBe(false);
    expect(sameFileIdentity(fakeStat(), fakeStat({ ino: 3n }))).toBe(false);
    expect(sameFileIdentity(fakeStat(), fakeStat({ mode: 0o100644n }))).toBe(false);
    expect(sameFileIdentity(fakeStat(), fakeStat({ uid: 1001n }))).toBe(false);
    expect(sameFileIdentity(fakeStat(), fakeStat({ size: 5n }))).toBe(false);
    expect(sameFileIdentity(fakeStat(), fakeStat({ mtimeNs: 101n }))).toBe(false);
  });
});

describe('readBoundedFileAtIdentity', () => {
  const content = Buffer.from('true');

  function readingStorage(overrides: Partial<BoundedFileReadStorage> = {}): BoundedFileReadStorage {
    return {
      lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false }),
      statSync: () => fakeStat(),
      openSync: () => 7,
      fstatSync: () => fakeStat(),
      readSync: (_fd, buffer, offset) => {
        if (offset !== 0) return 0;
        content.copy(buffer, 0);
        return content.length;
      },
      closeSync: () => {},
      ...overrides,
    };
  }

  it('reads bytes matching the baseline identity, then closes the descriptor', () => {
    let closed = false;
    const storage = readingStorage({ closeSync: () => (closed = true) });

    expect(readBoundedFileAtIdentity(storage, '/x', fakeStat(), 64)?.toString('utf-8')).toBe('true');
    expect(closed).toBe(true);
  });

  it('refuses a baseline already over the byte cap without opening the file', () => {
    let opened = false;
    const storage = readingStorage({ openSync: () => ((opened = true), 7) });

    expect(readBoundedFileAtIdentity(storage, '/x', fakeStat({ size: 100n }), 4)).toBeNull();
    expect(opened).toBe(false);
  });

  it('refuses a file whose identity had already moved by the time it was opened', () => {
    const storage = readingStorage({ fstatSync: () => fakeStat({ ino: 999n }) });

    expect(readBoundedFileAtIdentity(storage, '/x', fakeStat(), 64)).toBeNull();
  });

  it('refuses a file whose owner changed while the read was in flight', () => {
    let fstatCalls = 0;
    const storage = readingStorage({
      fstatSync: () => {
        fstatCalls += 1;
        return fstatCalls === 1 ? fakeStat() : fakeStat({ uid: 999n });
      },
    });

    expect(readBoundedFileAtIdentity(storage, '/x', fakeStat(), 64)).toBeNull();
  });

  it('refuses a path replaced by a symlink while the read was in flight', () => {
    const storage = readingStorage({ lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => true }) });

    expect(readBoundedFileAtIdentity(storage, '/x', fakeStat(), 64)).toBeNull();
  });

  it('refuses a path whose full stat moved while the read was in flight', () => {
    const storage = readingStorage({ statSync: () => fakeStat({ size: 999n }) });

    expect(readBoundedFileAtIdentity(storage, '/x', fakeStat(), 64)).toBeNull();
  });

  it('refuses a read that produced more bytes than the baseline promised', () => {
    const storage = readingStorage({
      fstatSync: () => fakeStat({ size: 2n }),
      readSync: (_fd, buffer, offset) => {
        buffer.fill(1, offset, offset + 1);
        return 1;
      },
    });

    expect(readBoundedFileAtIdentity(storage, '/x', fakeStat({ size: 2n }), 2)).toBeNull();
  });

  it('refuses a short read that silently stopped before the descriptor’s own reported size', () => {
    // A `readSync` that reports 0 bytes before the file's real size is reached — a short read, not EOF — must
    // not be indistinguishable from a clean read of a shorter file: the descriptor still reports the original
    // size throughout, so nothing else here observes the truncation.
    let calls = 0;
    const storage = readingStorage({
      readSync: (_fd, buffer, offset) => {
        calls += 1;
        if (calls > 1) return 0;
        buffer.fill(1, offset, offset + 2);
        return 2;
      },
    });

    expect(readBoundedFileAtIdentity(storage, '/x', fakeStat(), 64)).toBeNull();
  });

  it('closes the descriptor even when the read throws', () => {
    let closed = false;
    const storage = readingStorage({
      readSync: () => {
        throw new Error('boom');
      },
      closeSync: () => (closed = true),
    });

    expect(readBoundedFileAtIdentity(storage, '/x', fakeStat(), 64)).toBeNull();
    expect(closed).toBe(true);
  });
});
