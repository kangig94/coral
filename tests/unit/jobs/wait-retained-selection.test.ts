import { describe, expect, it } from 'vitest';
import { JobAddressing } from '#src/jobs/addressing.js';
import type { JobLocation, JobLocationView } from '#src/jobs/location-index.js';
import { admitted } from '#tests/helpers/wait-session.js';
import { VirtualTime } from '#tools/simulation/core/virtual-time.js';

function fixture(epochKey: 'retained' | 'active' = 'retained') {
  const execution = (ordinal: number, requestedSeq: number, end: number) => {
    const detail = admitted('a', [], true, epochKey, false, end).detail;
    return {
      execution: ordinal,
      requestedSeq,
      seq: end,
      resultPath: `/results/a/executions/${ordinal}/result.md`,
      detail: { ...detail, status: { ...detail.status, execution: ordinal } },
    };
  };
  const executions = [execution(1, 10, 20), execution(2, 30, 40)];
  const location: JobLocation = {
    version: 'v1',
    jobId: 'a',
    epochKey,
    disposition: 'terminal',
    subject: { projectRoot: '/tmp', workDir: '/tmp', jobKind: 'provider' },
    executions,
    latestExecution: 2,
    terminalSeq: 40,
    resultPath: executions[1].resultPath,
    detail: { kind: 'recorded', value: executions[1].detail },
  };
  const view = {
    time: new VirtualTime(),
    read: () => location,
    unknownLocationHolds: () => [],
  } as unknown as JobLocationView;
  const addressing = new JobAddressing(
    view,
    {
      epochKey: () => 'active',
      detail: () =>
        epochKey === 'active'
          ? {
              ...executions[1].detail,
              executions: executions.map(({ detail, execution, requestedSeq, resultPath }) => ({
                ...detail,
                execution,
                requestedSeq,
                resultPath,
              })),
            }
          : null,
      abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
    },
    () => false,
    () => 'decided',
    () => ({ kind: 'read', locations: new Map([['a', location]]), dispositions: new Map([['a', 'readable']]) }),
    (_id, ordinal) => ({ kind: 'available', resultPath: `/results/a/executions/${ordinal}/result.md` }),
  );
  return { addressing, location };
}

describe('cursor-only waits of a two-execution job', () => {
  it.each(['retained', 'active'] as const)(
    'should admit the latest %s execution and deliver its terminal even past the cursor',
    (epochKey) => {
      const { addressing } = fixture(epochKey);
      const [admission] = addressing.admitWait({ jobIds: ['a'], cursor: '45' });
      expect(admission).toMatchObject({ disposition: 'admitted', selection: { requestedSeq: 30 } });
      expect(admission.selection?.deliveredEndSeq).toBeUndefined();
      const [job] = addressing.snapshot({ jobIds: ['a'], cursor: '45' }).jobs;
      expect(job).toMatchObject({ execution: 2 });
      expect(job.terminal).toBeDefined();
    },
  );
});

describe('retained wait selections', () => {
  it('validates and reopens a past execution independently of the latest terminal copy', () => {
    const { addressing } = fixture();
    const pin = { jobId: 'a', epochKey: 'retained', requestedSeq: 10, awaitingArtifact: false };
    const admitted = addressing.admitWait({ jobIds: ['a'], cursor: '0', executionSelections: [pin] });
    expect(admitted[0]).toMatchObject({
      selection: pin,
      detail: { terminalSeq: 20, status: { execution: 1 } },
      availability: { resultPath: '/results/a/executions/1/result.md' },
    });
    expect(
      addressing.admitWait({ jobIds: ['a'], executionSelections: [{ ...pin, deliveredEndSeq: 20 }] })[0],
    ).toMatchObject({ selection: { requestedSeq: 30 }, detail: { terminalSeq: 40 } });
  });

  it('admits the latest retained execution for a scalar cursor and refuses invalid delivered-end evidence', () => {
    const { addressing } = fixture();
    expect(addressing.admitWait({ jobIds: ['a'], cursor: '25' })[0]).toMatchObject({
      detail: { status: { execution: 2 } },
    });
    expect(() =>
      addressing.admitWait({
        jobIds: ['a'],
        executionSelections: [
          { jobId: 'a', epochKey: 'retained', requestedSeq: 10, deliveredEndSeq: 40, awaitingArtifact: false },
        ],
      }),
    ).toThrow(
      expect.objectContaining({ code: 'wait_selection_invalid', remedy: { kind: 'fresh-wait', jobIds: ['a'] } }),
    );
  });

  it('keeps unavailable request or epoch evidence unknown instead of selecting latest', () => {
    const { addressing } = fixture();
    for (const selection of [
      { jobId: 'a', epochKey: 'retained', requestedSeq: 999, awaitingArtifact: false },
      { jobId: 'a', epochKey: 'missing', requestedSeq: 10, awaitingArtifact: false },
    ])
      expect(addressing.admitWait({ jobIds: ['a'], executionSelections: [selection] })[0]).toMatchObject({
        disposition: 'unknown',
      });
  });
});

it('does not admit or refuse acknowledgement-only members of a resumed multi-job wait', () => {
  const { addressing } = fixture();
  expect(
    addressing.admitWait({
      jobIds: ['a'],
      executionSelections: [
        { jobId: 'acknowledged', epochKey: 'retired', requestedSeq: 1, deliveredEndSeq: 2, awaitingArtifact: false },
      ],
    }),
  ).toMatchObject([{ jobId: 'a', disposition: 'admitted', detail: { status: { execution: 2 } } }]);
});
