import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { describe, expect, it, vi } from 'vitest';

import { executionHarness, openedJob, requestedExecution, EXECUTION_JOB_ID } from '#tests/helpers/job-executions.js';
import { createCoordinatorRpcPorts } from '#src/coordinator/composition/rpc-ports.js';
import type { ProjectRequestPort } from '#src/coordinator/contracts.js';
import { canonicalizeWorkDir } from '#src/runtime/canonical-work-dir.js';
import type { InvocationContext } from '#src/runtime/invocation-context.js';

describe('coordinator RPC ports', () => {
  it.each([null, '/owning-project'])(
    'routes send using persisted owner %s and retains caller authorization context',
    async (ownerRoot) => {
      const h = executionHarness();
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
        jobId: EXECUTION_JOB_ID,
        input: 'Keep the API.',
        target: { mode: 'steer' as const, execution: 1, requestedSeq: 2, sourceEpoch: 'epoch' },
        clientMessageId: '11111111-1111-4111-8111-111111111111',
      };
      const send = vi.fn<ProjectRequestPort['send']>(async () => ({
        state: 'delivered',
        providerTurnId: 'turn-1',
      }));
      const getExecutionService = vi.fn(() => ({ send }));
      if (ownerRoot !== null) {
        const opened = openedJob();
        if (opened.body.jobKind !== 'provider') throw new Error('Expected provider fixture');
        h.append(
          openedJob({ projectRoot: ownerRoot, conversation: { ...opened.body.conversation, cwd: projectRoot } }),
          requestedExecution(),
        );
      }
      const createOwnerInvocationContext = (root: string): InvocationContext => ({
        ...ctx,
        projectRoot: root as InvocationContext['projectRoot'],
        coralEnv: {},
        principal: {
          subject: 'system',
          transport: 'internal',
          credential: { kind: 'internal', id: 'owner' },
          binding: { kind: 'project', root: root as InvocationContext['projectRoot'] },
        },
      });
      const ports = createCoordinatorRpcPorts({
        time: new SimulationRuntime().time,
        services: { getExecutionService },
        getProgressStore: () => ({ getDb: () => h.db }),
        createOwnerInvocationContext,
      } as unknown as Parameters<typeof createCoordinatorRpcPorts>[0]);

      await expect(ports.jobs.send(request, ctx)).resolves.toEqual({
        state: 'delivered',
        providerTurnId: 'turn-1',
      });
      expect(getExecutionService).toHaveBeenCalledExactlyOnceWith(
        ownerRoot === null ? ctx : createOwnerInvocationContext(ownerRoot),
      );
      expect(send).toHaveBeenCalledExactlyOnceWith({ ...request, conversationReadDeadline: expect.any(Number) }, ctx);
      h.db.close();
    },
  );
});
