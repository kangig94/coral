import { describe, expect, it, vi } from 'vitest';

import { claudeArtifactCapability } from '#src/providers/claude/artifacts.js';
import { TEST_CLAUDE_ACCESS } from '#tests/helpers/provider-credentials.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

describe('claudeArtifactCapability.discardArtifacts', () => {
  it('discards a quiescent native log and reconciles proven absence without replay', async () => {
    const runtime = new SimulationRuntime();
    const handle = '/native/ref-a.jsonl';
    runtime.storage.mkdirSync('/native');
    runtime.storage.writeFileSync(handle, '{}\n');
    const unlink = vi.spyOn(runtime.storage, 'unlinkSync');
    const action = { handles: [handle], actionId: 'test-action', payloadHash: 'test-payload',
      access: TEST_CLAUDE_ACCESS, runtime };
    await expect(claudeArtifactCapability.discardArtifacts(action)).resolves.toMatchObject({ kind: 'discarded' });
    expect(runtime.storage.existsSync(handle)).toBe(false);
    expect(await claudeArtifactCapability.reconcileDiscard(action)).toMatchObject({ kind: 'applied', outcome: { kind: 'discarded' } });
    expect(unlink).toHaveBeenCalledExactlyOnceWith(handle);
  });
});
