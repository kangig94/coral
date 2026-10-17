import { describe, expect, it, vi } from 'vitest';

import { createCoordinatorRpcPorts } from '#src/coordinator/composition/rpc-ports.js';
import type { ProjectRequestPort } from '#src/coordinator/contracts.js';
import { canonicalizeWorkDir } from '#src/runtime/canonical-work-dir.js';
import type { InvocationContext } from '#src/runtime/invocation-context.js';

describe('coordinator RPC ports', () => {
  it('should issue send once through the execution service selected by the caller context', async () => {
    const projectRoot = canonicalizeWorkDir(process.cwd(), process.cwd());
    const ctx: InvocationContext = {
      projectRoot,
      pluginRoot: '/plugin',
      coralEnv: {},
      principal: {
        subject: 'operator',
        transport: 'test',
        credential: { kind: 'test', id: 'operator' },
        binding: { kind: 'project', root: projectRoot },
      },
    };
    const request = {
      projectRoot,
      jobId: 'job-1',
      input: 'Keep the API.',
      clientMessageId: '11111111-1111-4111-8111-111111111111',
    };
    const send = vi.fn<ProjectRequestPort['send']>(async () => ({
      state: 'delivered',
      providerTurnId: 'turn-1',
    }));
    const getExecutionService = vi.fn(() => ({ send }));
    const ports = createCoordinatorRpcPorts({
      services: { getExecutionService },
    } as unknown as Parameters<typeof createCoordinatorRpcPorts>[0]);

    await expect(ports.jobs.send(request, ctx)).resolves.toEqual({
      state: 'delivered',
      providerTurnId: 'turn-1',
    });
    expect(getExecutionService).toHaveBeenCalledExactlyOnceWith(ctx);
    expect(send).toHaveBeenCalledExactlyOnceWith(request);
  });
});
