import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PROVIDER_OPERATIONS_TRANSFER_GENERATION } from '#src/coordinator/services/provider-proxy-set/controller-transfer.js';
import {
  PROVIDER_OPERATIONS_OWNER,
  PROVIDER_PROXY_SETS_OWNER,
} from '#src/coordinator/succession/provider-host-transfer.js';
import { SUCCESSION_CAPABILITIES_FILE } from '#src/infra/bundle-manifest-address.js';
import { PROVIDER_PROXY_CONTROL_GENERATION } from '#src/provider-proxy/controller-succession.js';
import { assertBuildArtifactsAvailable } from '#tests/integration/coordinator/helpers.js';

describe('built succession capabilities', () => {
  it('should declare exactly the provider generations this build can take over', () => {
    assertBuildArtifactsAvailable();
    const declared = JSON.parse(
      readFileSync(join(process.cwd(), 'clients', 'build', SUCCESSION_CAPABILITIES_FILE), 'utf8'),
    ) as { accepts: unknown };

    expect(declared.accepts).toEqual([
      { owner: 'durable-cli', generation: 1 },
      { owner: PROVIDER_OPERATIONS_OWNER, generation: PROVIDER_OPERATIONS_TRANSFER_GENERATION },
      { owner: PROVIDER_PROXY_SETS_OWNER, generation: PROVIDER_PROXY_CONTROL_GENERATION },
    ]);
  });
});
