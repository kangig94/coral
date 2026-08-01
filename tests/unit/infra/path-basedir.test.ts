import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { storePaths } from '#src/infra/path/store.js';

describe('baseDir-partitioned store paths', () => {
  it('inherits the generation segment inside the partition root', () => {
    const baseDir = join('/tmp', 'coral-by-config', 'partition-hash');
    const paths = storePaths('prod', { baseDir });

    expect(paths.dbDir).toBe(join(baseDir, 'gen2', 'data', 'store'));
    expect(paths.dbFile).toBe(join(baseDir, 'gen2', 'data', 'store', 'store.db'));
  });
});
