import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { claudeAppServerLifecycle } from '#src/providers/claude/provider-facets.js';
import { compileClaudeBrokerHost } from '#src/providers/claude/execution-plan.js';
import { buildClaudeChildArgs, createClaudeBrokerServer } from '#src/providers/claude/appserver/server.js';
import * as brokerPool from '#src/providers/claude/appserver/broker-pool.js';
import { SingleSessionController } from '#src/providers/claude/appserver/controller.js';
import { PrintSessionController } from '#src/providers/claude/appserver/print-controller.js';
import { hostFingerprintFromSpec } from '#src/providers/host-identity.js';
import type { ClaudeBrokerSession } from '#src/providers/claude/appserver/session-contract.js';
import { TEST_CLAUDE_ACCESS } from '#tests/helpers/provider-credentials.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { EXECUTION_JOB_ID as jobId } from '#tests/helpers/job-executions.js';

const cwd = fixtureCanonicalWorkDir('/workspace');
afterEach(() => vi.restoreAllMocks());

function plan(
  action: 'exec' | 'resume',
  coralEnv: Record<string, string>,
  purpose: 'execution' | 'curation' = 'execution',
) {
  const common = {
    access: TEST_CLAUDE_ACCESS,
    baseEnv: {},
    platform: 'linux',
    hostRoot: '/plugin/bridge',
    storage: { existsSync: () => true },
  };
  return purpose === 'execution'
    ? claudeAppServerLifecycle.planHost({
        ...common,
        purpose,
        request: {
          jobId,
          action,
          cwd,
          coralEnv,
          prompt: 'next',
          conversationRef: 'native-conversation',
          bypassPermissions: false,
        },
      })
    : claudeAppServerLifecycle.planHost({ ...common, purpose, request: { cwd, prompt: 'curate' } });
}

describe('Claude continuation transport', () => {
  it.each(['workflow', 'discussion'])(
    'selects the actual TUI broker/controller for a %s continuation',
    async (owner) => {
      const environments: Record<string, string>[] = [
        { CORAL_OWNER: owner },
        { CORAL_OWNER: owner, CORAL_CLAUDE_TRANSPORT: 'print' },
      ];
      for (const coralEnv of environments) {
        const host = plan('resume', coralEnv);
        const compiled = compileClaudeBrokerHost(host);
        expect(compiled.transportMode).toBe('tui');
        expect(compiled.environment.CORAL_CLAUDE_TRANSPORT).toBe('tui');
        const initialSpec = claudeAppServerLifecycle.compileStableHost(plan('exec', coralEnv));
        const continuedSpec = claudeAppServerLifecycle.compileStableHost(host);
        expect(hostFingerprintFromSpec(continuedSpec)).not.toBe(hostFingerprintFromSpec(initialSpec));
        const original = brokerPool.createBrokerSession;
        let session: ClaudeBrokerSession | undefined;
        const pool = vi.spyOn(brokerPool, 'createBrokerSession').mockImplementation((options) => {
          session = original(options);
          return session;
        });
        const bootstrapSignature = {
          cwd,
          permissionMode: 'default' as const,
          systemPromptHash: 'system',
          bootstrapConfigHash: 'bootstrap',
        };
        const tui = vi.spyOn(SingleSessionController.prototype, 'sessionEnsure').mockResolvedValue({
          bootstrapSignature,
          sessionId: 'native-conversation',
          conversationRef: 'native-conversation',
          activeTurnId: null,
          initialized: true,
        });
        const print = vi
          .spyOn(PrintSessionController.prototype, 'sessionEnsure')
          .mockRejectedValue(new Error('Unexpected print controller.'));
        const input = new PassThrough();
        const output = new PassThrough();
        const errors = new PassThrough();
        createClaudeBrokerServer({ env: compiled.environment, input, output, errorOutput: errors });
        if (session === undefined) throw new Error('Expected the real broker pool.');
        await session.sessionEnsure({
          ...bootstrapSignature,
          projectsRoot: TEST_CLAUDE_ACCESS.projectsRoot,
          conversationRef: 'native-conversation',
          resumeExisting: true,
        });
        expect(tui).toHaveBeenCalledOnce();
        expect(print).not.toHaveBeenCalled();
        const args = buildClaudeChildArgs({
          cwd,
          conversationRef: 'native-conversation',
          resume: true,
          permissionMode: 'default',
        });
        expect(args).toEqual(['--resume', 'native-conversation']);
        expect(args).not.toContain('-p');
        await session.shutdown();
        input.destroy();
        output.destroy();
        errors.destroy();
        pool.mockRestore();
        tui.mockRestore();
        print.mockRestore();
      }
    },
  );

  it('preserves initial execution selection and curation print transport', () => {
    expect(compileClaudeBrokerHost(plan('exec', {})).transportMode).toBe('print');
    expect(compileClaudeBrokerHost(plan('exec', { CORAL_CLAUDE_TRANSPORT: 'tui' })).transportMode).toBe('tui');
    expect(compileClaudeBrokerHost(plan('exec', {}, 'curation')).transportMode).toBe('print');
  });
});
