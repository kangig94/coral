import { describe, expect, it, vi } from 'vitest';
import { executeCatalogRequest } from '#src/transport/dispatch.js';
import { rpcCatalog } from '#src/transport/rpc/catalog.js';
import type { HttpHandlerPorts } from '#src/transport/server-ports.js';
import type { Principal } from '#src/security/principal.js';
import { canonicalizeWorkDir } from '#src/runtime/canonical-work-dir.js';
import { WaitSessionError } from '#src/jobs/wait/session.js';
import { mapWaitSubscriptionError } from '#src/cli/wait-stream-error.js';

const spec = rpcCatalog.find((entry) => entry.name === 'jobs.wait')!;
const projectRoot = canonicalizeWorkDir(process.cwd(), process.cwd());
const operator: Principal = { subject: 'operator', transport: 'test', credential: { kind: 'test', id: 'operator' }, binding: { kind: 'unbound' } };
function fixture() {
  const admitWait = vi.fn(() => { throw new WaitSessionError('wait_admission_required', 'Execution admission evidence is required.'); });
  const ports = {
    identity: { pluginRoot: '/plugin', bootToken: 'boot-token', now: () => 0, log: vi.fn() },
    coralEnvSnapshot: {},
    admin: { isLifecycleRunning: () => true, isDrainRequested: () => false, isLaunchFenceActive: () => false, beginRequest: vi.fn(), endRequest: vi.fn() },
    jobs: { admitWait },
  } as unknown as HttpHandlerPorts;
  return { ports, admitWait };
}

describe('wait admission refusals', () => {
  it('returns a typed remedy for an ambiguous bare cursor before opening a subscription', async () => {
    const { ports, admitWait } = fixture();
    const result = await executeCatalogRequest(spec, { jobIds: ['a'], projectRoot, cursor: '279' }, ports, operator);
    expect(admitWait).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ kind: 'unary', statusCode: 400, body: { code: 'wait_admission_required', remedy: { kind: 'fresh-wait', jobIds: ['a'] } } });
    const error = mapWaitSubscriptionError(new Error('wire', { cause: { code: 'wait_admission_required', message: 'Admission required.', remedy: { kind: 'fresh-wait', jobIds: ['a'] } } }));
    expect(error).toMatchObject({ message: expect.stringContaining('coral-cli jobs wait a') });
    expect((error as Error).message).not.toContain('--cursor');
  });

  it('refuses malformed selection state without admitting a replacement', async () => {
    const { ports, admitWait } = fixture();
    const result = await executeCatalogRequest(spec, { jobIds: ['a'], projectRoot, cursor: '279', executionSelections: [{ jobId: 'a', requestedSeq: 1000 }] }, ports, operator);
    expect(result).toMatchObject({ kind: 'unary', statusCode: 400, body: { code: 'wait_selection_invalid' } });
    expect(admitWait).not.toHaveBeenCalled();
  });
});
