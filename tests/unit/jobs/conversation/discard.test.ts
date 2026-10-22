import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  discardRecordedArtifacts,
  managed,
  reconcileRecordedArtifactDiscard,
  sealProviderArtifactDiscard,
} from '#src/providers/capability.js';
import type { ProviderAccess } from '#src/providers/contract.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { createDeferred } from '#tools/testing/deferred.js';

function fixture(handles = ['/native/one.jsonl']) {
  const runtime = new SimulationRuntime();
  runtime.storage.mkdirSync('/native');
  for (const handle of handles) runtime.storage.writeFileSync(handle, 'native');
  vi.spyOn(runtime.time, 'sleep').mockImplementation(async (ms) => {
    runtime.time.tick(ms);
  });
  const options = {
    handles,
    runtime,
    actionId: 'discard-stable-action',
    payloadHash: 'same-payload',
    access: {} as ProviderAccess,
  };
  const ledger = () =>
    JSON.parse(
      runtime.storage.readFileSync(
        join(
          runtime.paths.coral.exports.jobsRoot,
          '.provider-artifact-discard.v2',
          `${createHash('sha256').update(options.actionId).digest('hex')}.json`,
        ),
        'utf-8',
      ),
    );
  return { runtime, options, ledger };
}
function errno(code: string) {
  return Object.assign(new Error(code), { code });
}

describe('truthful provider discard evidence', () => {
  it('reports no handles as a no-effect outcome', async () => {
    const f = fixture([]);
    const effect = vi.fn(async () => ({ kind: 'discarded' }) as const);
    const capability = managed({ discardArtifacts: effect });
    expect(await capability.discardArtifacts(f.options)).toMatchObject({ kind: 'skipped_no_handles' });
    expect(await capability.reconcileDiscard(f.options)).toMatchObject({
      kind: 'applied',
      outcome: { kind: 'skipped_no_handles' },
    });
    expect(effect).not.toHaveBeenCalled();
  });

  it('accepts only generation two at the current discard ledger address', async () => {
    const f = fixture();
    const capability = managed({
      discardArtifacts: ({ handles, runtime }) => discardRecordedArtifacts(handles, runtime),
    });
    await capability.discardArtifacts(f.options);
    const record = f.ledger();
    expect(record.v).toBe(2);
    const path = join(
      f.runtime.paths.coral.exports.jobsRoot,
      '.provider-artifact-discard.v2',
      `${createHash('sha256').update(f.options.actionId).digest('hex')}.json`,
    );
    f.runtime.storage.writeFileSync(path, JSON.stringify({ ...record, v: 1 }));
    await expect(capability.reconcileDiscard(f.options)).rejects.toThrow('Unreadable provider artifact action');
  });

  it('never records applied after all six EACCES unlink attempts', async () => {
    const f = fixture();
    const unlink = vi.spyOn(f.runtime.storage, 'unlinkSync').mockImplementation(() => {
      throw errno('EACCES');
    });
    const capability = managed({
      discardArtifacts: ({ handles, runtime }) => discardRecordedArtifacts(handles, runtime),
    });
    await expect(capability.discardArtifacts(f.options)).rejects.toThrow('Native removal failed');
    expect(unlink).toHaveBeenCalledTimes(6);
    expect(f.runtime.time.sleep).toHaveBeenCalledTimes(5);
    expect(f.ledger().state.kind).toBe('definitive-failure');
    expect(await capability.reconcileDiscard(f.options)).toMatchObject({ kind: 'definitive-failure' });
    await expect(capability.discardArtifacts(f.options)).rejects.toThrow();
    expect(unlink).toHaveBeenCalledTimes(6);
    expect(f.runtime.storage.readFileSync('/native/one.jsonl', 'utf-8')).toBe('native');
  });

  it('does not trust a fake provider reporting success while native bytes survive', async () => {
    const f = fixture();
    const capability = managed({ discardArtifacts: async () => ({ kind: 'discarded' }) });
    await expect(capability.discardArtifacts(f.options)).rejects.toThrow('Native removal failed');
    expect(f.ledger().observations).toEqual({ present: f.options.handles, absent: [], unknown: [] });
    expect(await capability.reconcileDiscard(f.options)).toMatchObject({ kind: 'definitive-failure' });
  });

  it('distinguishes partial removal from keeping every handle', async () => {
    const f = fixture(['/native/one.jsonl', '/native/two.jsonl']);
    const capability = managed({
      discardArtifacts: async ({ runtime, handles }) => {
        runtime.storage.unlinkSync(handles[0]);
        return { kind: 'discarded' };
      },
    });
    await expect(capability.discardArtifacts(f.options)).rejects.toThrow('Native removal failed');
    expect(f.ledger().observations).toEqual({
      present: ['/native/two.jsonl'],
      absent: ['/native/one.jsonl'],
      unknown: [],
    });
  });

  it('treats failed stat observations as unknown and seals without replaying the action', async () => {
    const f = fixture();
    const effect = vi.fn(async () => ({ kind: 'discarded' }) as const);
    const capability = managed({ discardArtifacts: effect });
    const stat = vi.spyOn(f.runtime.storage, 'lstatSync').mockImplementation(() => {
      throw errno('EACCES');
    });
    await expect(capability.discardArtifacts(f.options)).rejects.toThrow('unknown');
    expect(await capability.reconcileDiscard(f.options)).toEqual({ kind: 'unknown' });
    expect(reconcileRecordedArtifactDiscard(f.options.handles, f.runtime)).toEqual({ kind: 'unknown' });
    await sealProviderArtifactDiscard(f.options, 'Removal unknown after six observations.');
    stat.mockRestore();
    await expect(capability.discardArtifacts(f.options)).rejects.toThrow('unknown');
    expect(effect).toHaveBeenCalledTimes(1);
    expect(f.ledger().observations).toEqual({ present: [], absent: [], unknown: f.options.handles });
  });

  it('waits for the original issuer to stop before reconciling or sealing', async () => {
    const f = fixture();
    const done = createDeferred<void>();
    const capability = managed({
      discardArtifacts: async ({ handles, runtime }) => {
        runtime.storage.unlinkSync(handles[0]);
        await done.promise;
        return { kind: 'discarded' };
      },
    });
    const issued = capability.discardArtifacts(f.options);
    expect(await capability.reconcileDiscard(f.options)).toEqual({ kind: 'unknown' });
    await expect(sealProviderArtifactDiscard(f.options, 'unknown')).resolves.toMatchObject({
      kind: 'awaiting-issuer',
      actionId: f.options.actionId,
    });
    done.resolve();
    expect(await issued).toMatchObject({ kind: 'discarded' });
    expect(await capability.reconcileDiscard(f.options)).toMatchObject({ kind: 'applied' });
  });

  it('recovers pending discard by existence after a crash before the applied ledger write', async () => {
    const f = fixture();
    const write = f.runtime.storage.writeAtomicDurableSync.bind(f.runtime.storage);
    vi.spyOn(f.runtime.storage, 'writeAtomicDurableSync').mockImplementation((path, data, options) => {
      if (typeof data === 'string' && data.includes('"kind":"applied"')) throw new Error('crash after unlink');
      return write(path, data, options);
    });
    const effect = vi.fn(async ({ handles, runtime }: typeof f.options) => {
      runtime.storage.unlinkSync(handles[0]);
      return { kind: 'discarded' } as const;
    });
    const capability = managed({ discardArtifacts: effect });
    await expect(capability.discardArtifacts(f.options)).rejects.toThrow('crash after unlink');
    expect(f.ledger().state.kind).toBe('pending');
    vi.restoreAllMocks();
    const restarted = managed({ discardArtifacts: effect });
    expect(await restarted.reconcileDiscard(f.options)).toMatchObject({
      kind: 'applied',
      outcome: { kind: 'discarded' },
    });
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it('requires the recorded issuer to stop before a successor reconciles or seals its pending action', async () => {
    const f = fixture();
    const capability = managed({
      discardArtifacts: ({ handles, runtime }) => discardRecordedArtifacts(handles, runtime),
    });
    await capability.discardArtifacts(f.options);
    const record = f.ledger();
    record.state = { kind: 'pending' };
    record.issuerStopped = false;
    const path = join(
      f.runtime.paths.coral.exports.jobsRoot,
      '.provider-artifact-discard.v2',
      `${createHash('sha256').update(f.options.actionId).digest('hex')}.json`,
    );
    f.runtime.storage.writeFileSync(path, JSON.stringify(record));
    const effect = vi.fn(async () => ({ kind: 'discarded' }) as const);
    const successor = managed({ discardArtifacts: effect });
    expect(await successor.reconcileDiscard(f.options)).toEqual({ kind: 'unknown' });
    await expect(sealProviderArtifactDiscard(f.options, 'unknown')).resolves.toMatchObject({
      kind: 'awaiting-issuer',
      actionId: f.options.actionId,
    });
    f.runtime.spawner.setAlive(record.issuer.pid, false);
    expect(await successor.reconcileDiscard(f.options)).toMatchObject({ kind: 'applied' });
    expect(f.ledger().issuerStopped).toBe(true);
    expect(f.ledger().issuer).toEqual(record.issuer);
    expect(effect).not.toHaveBeenCalled();
  });

  it('rejects action-id reuse with a different payload and does not hide recreated files behind cached success', async () => {
    const f = fixture();
    const capability = managed({
      discardArtifacts: ({ handles, runtime }) => discardRecordedArtifacts(handles, runtime),
    });
    await capability.discardArtifacts(f.options);
    await expect(capability.reconcileDiscard({ ...f.options, payloadHash: 'other' })).rejects.toThrow(
      'conflicting payload',
    );
    f.runtime.storage.writeFileSync('/native/one.jsonl', 'new execution');
    expect(await capability.reconcileDiscard(f.options)).toMatchObject({ kind: 'definitive-failure' });
    expect(f.runtime.storage.readFileSync('/native/one.jsonl', 'utf-8')).toBe('new execution');
  });
});
