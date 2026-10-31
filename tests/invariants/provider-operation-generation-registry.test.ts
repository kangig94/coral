import { describe, expect, it } from 'vitest';

import { PROVIDER_OPERATION_RECORD_GENERATIONS } from '#src/store/provider-operation-record.js';

describe('provider-operation-generation-registry', () => {
  it('should leave no generation between 1 and current that is neither decoded nor fenced', () => {
    const { retainedSuperseded, current } = PROVIDER_OPERATION_RECORD_GENERATIONS;
    expect([...retainedSuperseded, current]).toEqual(Array.from({ length: current }, (_, index) => index + 1));
  });
});
