import { describe, expect, it } from 'vitest';

import { verifyProviderProxyCodexSmokeEvidence } from '#tools/provider-proxy-smoke-release-gate.js';

const REPOSITORY = 'openai/coral';
const HEAD_SHA = 'a'.repeat(40);
const RUN_ID = 42;

function passingEvidence() {
  return {
    schemaVersion: 1,
    repository: REPOSITORY,
    headSha: HEAD_SHA,
    workflowRunId: RUN_ID,
    provider: 'codex',
    result: 'passed',
    secondOperationProxyRouted: true,
    committedThroughProviderSeq: 1,
    turnStartAfterAck: true,
    traceSha256: 'b'.repeat(64),
  };
}

function successfulRun(workflowId: number) {
  return {
    id: RUN_ID,
    workflow_id: workflowId,
    head_sha: HEAD_SHA,
    event: 'workflow_dispatch',
    conclusion: 'success',
    repository: { full_name: REPOSITORY },
  };
}

describe('provider proxy Codex smoke release gate', () => {
  it('requires protected-workflow provenance for Codex smoke evidence', () => {
    const workflow = {
      id: 7,
      path: '.github/workflows/provider-proxy-codex-smoke.yml',
    };
    const input = {
      repository: REPOSITORY,
      candidateSha: HEAD_SHA,
      workflowRunId: RUN_ID,
      workflow,
      evidence: passingEvidence(),
    };

    expect(() =>
      verifyProviderProxyCodexSmokeEvidence({
        ...input,
        run: successfulRun(999),
      }),
    ).toThrow('workflow run did not originate from the protected Codex smoke workflow');

    expect(
      verifyProviderProxyCodexSmokeEvidence({
        ...input,
        run: successfulRun(workflow.id),
      }),
    ).toEqual(passingEvidence());
  });

  it.each([
    ['stale SHA', { headSha: 'c'.repeat(40) }],
    ['false route fact', { secondOperationProxyRouted: false }],
    ['wrong watermark', { committedThroughProviderSeq: 2 }],
    ['absent trace', { traceSha256: '' }],
    ['extra field', { unexpected: true }],
  ])('rejects %s evidence', (_label, mutation) => {
    const workflow = { id: 7, path: '.github/workflows/provider-proxy-codex-smoke.yml' };
    expect(() =>
      verifyProviderProxyCodexSmokeEvidence({
        repository: REPOSITORY,
        candidateSha: HEAD_SHA,
        workflowRunId: RUN_ID,
        workflow,
        run: successfulRun(workflow.id),
        evidence: { ...passingEvidence(), ...mutation },
      }),
    ).toThrow();
  });
});
