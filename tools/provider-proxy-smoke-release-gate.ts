import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export type ProviderProxyCodexSmokeEvidenceV1 = Readonly<{
  schemaVersion: 1;
  repository: string;
  headSha: string;
  workflowRunId: number;
  provider: 'codex';
  result: 'passed';
  secondOperationProxyRouted: true;
  committedThroughProviderSeq: 1;
  turnStartAfterAck: true;
  traceSha256: string;
}>;

type WorkflowMetadata = Readonly<{ id: number; path: string }>;
type WorkflowRunMetadata = Readonly<{
  id: number;
  workflow_id: number;
  head_sha: string;
  event: string;
  conclusion: string | null;
  repository: Readonly<{ full_name: string }>;
}>;

export type ProviderProxySmokeReleaseGateInput = Readonly<{
  repository: string;
  candidateSha: string;
  workflowRunId: number;
  workflow: unknown;
  run: unknown;
  evidence: unknown;
}>;

const WORKFLOW_PATH = '.github/workflows/provider-proxy-codex-smoke.yml';
const FULL_GIT_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function strictRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} fields are not the strict expected shape`);
  }
  return record;
}

function requireInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${label} must be a positive integer`);
  return value as number;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a nonempty string`);
  return value;
}

function parseWorkflow(value: unknown): WorkflowMetadata {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('workflow metadata must be an object');
  }
  const record = value as Record<string, unknown>;
  const workflow = {
    id: requireInteger(record.id, 'workflow.id'),
    path: requireString(record.path, 'workflow.path'),
  };
  if (workflow.path !== WORKFLOW_PATH)
    throw new Error('resolved workflow path is not the protected Codex smoke workflow');
  return workflow;
}

function parseRun(value: unknown): WorkflowRunMetadata {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('workflow run metadata must be an object');
  }
  const record = value as Record<string, unknown>;
  const repository = record.repository;
  if (repository === null || typeof repository !== 'object' || Array.isArray(repository)) {
    throw new Error('workflow run repository must be an object');
  }
  return {
    id: requireInteger(record.id, 'run.id'),
    workflow_id: requireInteger(record.workflow_id, 'run.workflow_id'),
    head_sha: requireString(record.head_sha, 'run.head_sha'),
    event: requireString(record.event, 'run.event'),
    conclusion: record.conclusion === null ? null : requireString(record.conclusion, 'run.conclusion'),
    repository: {
      full_name: requireString((repository as Record<string, unknown>).full_name, 'run.repository.full_name'),
    },
  };
}

function parseEvidence(value: unknown): ProviderProxyCodexSmokeEvidenceV1 {
  const record = strictRecord(
    value,
    [
      'schemaVersion',
      'repository',
      'headSha',
      'workflowRunId',
      'provider',
      'result',
      'secondOperationProxyRouted',
      'committedThroughProviderSeq',
      'turnStartAfterAck',
      'traceSha256',
    ],
    'Codex smoke evidence',
  );
  if (
    record.schemaVersion !== 1 ||
    record.provider !== 'codex' ||
    record.result !== 'passed' ||
    record.secondOperationProxyRouted !== true ||
    record.committedThroughProviderSeq !== 1 ||
    record.turnStartAfterAck !== true
  ) {
    throw new Error('Codex smoke evidence does not contain the required passing facts');
  }
  const evidence = {
    schemaVersion: 1,
    repository: requireString(record.repository, 'evidence.repository'),
    headSha: requireString(record.headSha, 'evidence.headSha'),
    workflowRunId: requireInteger(record.workflowRunId, 'evidence.workflowRunId'),
    provider: 'codex',
    result: 'passed',
    secondOperationProxyRouted: true,
    committedThroughProviderSeq: 1,
    turnStartAfterAck: true,
    traceSha256: requireString(record.traceSha256, 'evidence.traceSha256'),
  } as const;
  if (!FULL_GIT_SHA.test(evidence.headSha)) throw new Error('evidence.headSha must be a lowercase full Git SHA');
  if (!SHA256.test(evidence.traceSha256)) throw new Error('evidence.traceSha256 must be a lowercase SHA-256 value');
  return evidence;
}

export function verifyProviderProxyCodexSmokeEvidence(
  input: ProviderProxySmokeReleaseGateInput,
): ProviderProxyCodexSmokeEvidenceV1 {
  if (!FULL_GIT_SHA.test(input.candidateSha)) throw new Error('candidate SHA must be a lowercase full Git SHA');
  const workflow = parseWorkflow(input.workflow);
  const run = parseRun(input.run);
  const evidence = parseEvidence(input.evidence);
  if (run.id !== input.workflowRunId) throw new Error('workflow run id does not match the requested smoke run');
  if (run.workflow_id !== workflow.id)
    throw new Error('workflow run did not originate from the protected Codex smoke workflow');
  if (run.repository.full_name !== input.repository) throw new Error('workflow run repository does not match release');
  if (run.event !== 'workflow_dispatch') throw new Error('Codex smoke run was not explicitly dispatched');
  if (run.conclusion !== 'success') throw new Error('Codex smoke workflow did not conclude successfully');
  if (run.head_sha !== input.candidateSha) throw new Error('workflow API head SHA does not match release candidate');
  if (evidence.repository !== input.repository) throw new Error('evidence repository does not match release');
  if (evidence.headSha !== input.candidateSha) throw new Error('evidence head SHA does not match release candidate');
  if (evidence.workflowRunId !== input.workflowRunId) throw new Error('evidence run id does not match requested run');
  return evidence;
}

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined || value.length === 0) throw new Error(`missing ${name}`);
  return value;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  verifyProviderProxyCodexSmokeEvidence({
    repository: argument('--repository'),
    candidateSha: argument('--candidate-sha'),
    workflowRunId: Number(argument('--run-id')),
    workflow: readJson(argument('--workflow-json')),
    run: readJson(argument('--run-json')),
    evidence: readJson(argument('--evidence-json')),
  });
  process.stdout.write('provider proxy Codex smoke evidence accepted\n');
}
