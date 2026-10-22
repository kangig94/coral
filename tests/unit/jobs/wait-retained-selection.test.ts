import { describe, expect, it } from 'vitest';
import { JobAddressing } from '#src/jobs/addressing.js';
import type { JobLocation, JobLocationView } from '#src/jobs/location-index.js';
import { admitted } from '#tests/helpers/wait-session.js';
import { VirtualTime } from '#tools/simulation/core/virtual-time.js';

function fixture() {
  const execution = (ordinal: number, requestedSeq: number, end: number) => {
    const detail = admitted('a', [], true, 'retained', false, end).detail;
    return { execution: ordinal, requestedSeq, seq: end, resultPath: `/results/a/executions/${ordinal}/result.md`, detail: { ...detail, status: { ...detail.status, execution: ordinal } } };
  };
  const executions = [execution(1, 10, 20), execution(2, 30, 40)];
  const location: JobLocation = {
    version: 'v1', jobId: 'a', epochKey: 'retained', disposition: 'terminal',
    subject: { projectRoot: '/tmp', workDir: '/tmp', jobKind: 'provider' },
    executions, latestExecution: 2, terminalSeq: 40, resultPath: executions[1].resultPath,
    detail: { kind: 'recorded', value: executions[1].detail },
  };
  const view = {
    time: new VirtualTime(), read: () => location, unknownLocationHolds: () => [],
  } as unknown as JobLocationView;
  const addressing = new JobAddressing(view, {
    epochKey: () => 'active', detail: () => null,
    abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
  }, () => false, () => 'decided', () => ({ kind: 'read', locations: new Map([['a', location]]) }),
  (_id, ordinal) => ({ kind: 'available', resultPath: `/results/a/executions/${ordinal}/result.md` }));
  return { addressing, location };
}

describe('retained wait selections', () => {
  it('validates and reopens a past execution independently of the latest terminal copy', () => {
    const { addressing } = fixture();
    const pin = { jobId: 'a', epochKey: 'retained', requestedSeq: 10, awaitingArtifact: false };
    const admitted = addressing.admitWait({ jobIds: ['a'], cursor: '0', executionSelections: [pin] });
    expect(admitted[0]).toMatchObject({ selection: pin, detail: { terminalSeq: 20, status: { execution: 1 } }, availability: { resultPath: '/results/a/executions/1/result.md' } });
    expect(addressing.admitWait({ jobIds: ['a'], executionSelections: [{ ...pin, deliveredEndSeq: 20 }] })[0]).toMatchObject({ selection: { requestedSeq: 30 }, detail: { terminalSeq: 40 } });
  });

  it('refuses a multi-execution scalar cursor and invalid delivered-end evidence', () => {
    const { addressing } = fixture();
    expect(() => addressing.admitWait({ jobIds: ['a'], cursor: '25' })).toThrow(expect.objectContaining({ code: 'wait_admission_required' }));
    expect(() => addressing.admitWait({ jobIds: ['a'], executionSelections: [{ jobId: 'a', epochKey: 'retained', requestedSeq: 10, deliveredEndSeq: 40, awaitingArtifact: false }] })).toThrow(expect.objectContaining({ code: 'wait_selection_invalid' }));
  });

  it('keeps unavailable request or epoch evidence unknown instead of selecting latest', () => {
    const { addressing } = fixture();
    for (const selection of [
      { jobId: 'a', epochKey: 'retained', requestedSeq: 999, awaitingArtifact: false },
      { jobId: 'a', epochKey: 'missing', requestedSeq: 10, awaitingArtifact: false },
    ]) expect(addressing.admitWait({ jobIds: ['a'], executionSelections: [selection] })[0]).toMatchObject({ disposition: 'unknown' });
  });
});
