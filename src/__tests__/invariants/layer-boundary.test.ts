import { describe, test } from 'vitest';

describe('layer-boundary invariants', () => {
  test.todo('L0 modules never import from L1 (execution/) or L2 (cli/, bridge/)');
  test.todo('client barrel only has type-only execution imports');
});
