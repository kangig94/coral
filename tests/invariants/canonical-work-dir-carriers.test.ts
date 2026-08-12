import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const REQUIRED_SOURCE_CARRIERS = [
  {
    carrier: 'InvocationContext.projectRoot',
    file: 'src/runtime/invocation-context.ts',
    pattern: /projectRoot:\s*CanonicalWorkDir/u,
  },
  {
    carrier: 'ResourceBinding.project.root',
    file: 'src/security/principal.ts',
    pattern: /kind:\s*'project';\s*readonly root:\s*CanonicalWorkDir/u,
  },
  {
    carrier: 'ProviderServerSpec.cwd',
    file: 'src/providers/contract.ts',
    pattern: /interface ProviderServerSpecBase[\s\S]*?cwd\?:\s*CanonicalWorkDir/u,
  },
  {
    carrier: 'JobLaunchRequest.cwd',
    file: 'src/jobs/launch.ts',
    pattern: /interface JobLaunchRequest[\s\S]*?cwd\?:\s*CanonicalWorkDir/u,
  },
  {
    carrier: 'WorkflowPortInput.workDir',
    file: 'src/transport/rpc/ports.ts',
    pattern: /type WorkflowPortInput[\s\S]*?workDir:\s*CanonicalWorkDir/u,
  },
  {
    carrier: 'CanonicalWorkflowCommand.workDir',
    file: 'src/workflow/compile.ts',
    pattern: /type CanonicalWorkflowCommand[\s\S]*?workDir:\s*CanonicalWorkDir/u,
  },
  {
    carrier: 'CompiledWorkflow.workDir',
    file: 'src/workflow/compile.ts',
    pattern: /type CompiledWorkflow[\s\S]*?workDir:\s*CanonicalWorkDir/u,
  },
  {
    carrier: 'WorkflowExecutionService.workDir',
    file: 'src/coordinator/services/workflow-execution.ts',
    pattern: /executeWorkflow\([\s\S]*?workDir:\s*CanonicalWorkDir/u,
  },
  {
    carrier: 'CoordinatorWorkflowOps.workDir',
    file: 'src/coordinator/contracts.ts',
    pattern: /interface CoordinatorWorkflowOps[\s\S]*?workDir:\s*CanonicalWorkDir/u,
  },
  {
    carrier: 'ExecuteAgentAttemptParams.cwd',
    file: 'src/discuss/shell/runtime-build.ts',
    pattern: /type ExecuteAgentAttemptParams[\s\S]*?cwd:\s*CanonicalWorkDir/u,
  },
  {
    carrier: 'WorkflowRecoveryDescendant.projectRoot',
    file: 'src/workflow/recover.ts',
    pattern: /type WorkflowRecoveryDescendant[\s\S]*?projectRoot:\s*CanonicalWorkDir/u,
  },
] as const;

const WORKFLOW_CLOSURE = [
  'src/workflow/compile.ts',
  'src/workflow/dispatch.ts',
  'src/workflow/execution-contract.ts',
  'src/workflow/executor.ts',
  'src/workflow/wait.ts',
  'src/workflow/launch.ts',
  'src/workflow/stale-recovery.ts',
  'src/workflow/recover.ts',
] as const;

const RAW_ASSIGNMENT_FIXTURE = `
import type { InvocationContext } from '../src/runtime/invocation-context.js';
import type { ResourceBinding } from '../src/security/principal.js';
import type { ProviderServerSpec } from '../src/providers/contract.js';
import type { JobLaunchRequest } from '../src/jobs/launch.js';
import type { WorkflowPortInput } from '../src/transport/rpc/ports.js';
import type { CanonicalWorkflowCommand, CompiledWorkflow } from '../src/workflow/compile.js';
import type { ExecuteAgentAttemptParams } from '../src/discuss/shell/runtime-build.js';
import type { WorkflowRecoveryDescendant } from '../src/workflow/recover.js';
import type { ProjectRequestPort } from '../src/coordinator/contracts.js';

declare const raw: string;
type ProjectBinding = Extract<ResourceBinding, { kind: 'project' }>;

declare let invocationRoot: InvocationContext['projectRoot'];
invocationRoot = raw; // @carrier InvocationContext.projectRoot
declare let bindingRoot: ProjectBinding['root'];
bindingRoot = raw; // @carrier ResourceBinding.project.root
declare let providerCwd: ProviderServerSpec['cwd'];
providerCwd = raw; // @carrier ProviderServerSpec.cwd
declare let launchCwd: JobLaunchRequest['cwd'];
launchCwd = raw; // @carrier JobLaunchRequest.cwd
declare let workflowPortWorkDir: WorkflowPortInput['workDir'];
workflowPortWorkDir = raw; // @carrier WorkflowPortInput.workDir
declare let canonicalCommandWorkDir: CanonicalWorkflowCommand['workDir'];
canonicalCommandWorkDir = raw; // @carrier CanonicalWorkflowCommand.workDir
declare let compiledWorkDir: CompiledWorkflow['workDir'];
compiledWorkDir = raw; // @carrier CompiledWorkflow.workDir
declare let discussCwd: ExecuteAgentAttemptParams['cwd'];
discussCwd = raw; // @carrier ExecuteAgentAttemptParams.cwd
declare let recoveryRoot: WorkflowRecoveryDescendant['projectRoot'];
recoveryRoot = raw; // @carrier WorkflowRecoveryDescendant.projectRoot
type CoordinatorWorkflowWorkDir = Parameters<ProjectRequestPort['executeWorkflow']>[4];
declare let coordinatorWorkflowWorkDir: CoordinatorWorkflowWorkDir;
coordinatorWorkflowWorkDir = raw; // @carrier CoordinatorWorkflowOps.workDir
`;

function createFixtureProgram(): { program: ts.Program; fixturePath: string } {
  const configPath = resolve(REPO_ROOT, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error !== undefined) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, REPO_ROOT, undefined, configPath);
  const options: ts.CompilerOptions = {
    ...parsed.options,
    composite: false,
    incremental: false,
    noEmit: true,
    rootDir: undefined,
    tsBuildInfoFile: undefined,
  };
  const fixturePath = resolve(REPO_ROOT, 'tests/canonical-work-dir-raw-assignment.fixture.ts');
  const host = ts.createCompilerHost(options, true);
  const defaultFileExists = host.fileExists.bind(host);
  const defaultReadFile = host.readFile.bind(host);
  const defaultGetSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (fileName) => fileName === fixturePath || defaultFileExists(fileName);
  host.readFile = (fileName) => (fileName === fixturePath ? RAW_ASSIGNMENT_FIXTURE : defaultReadFile(fileName));
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) =>
    fileName === fixturePath
      ? ts.createSourceFile(fileName, RAW_ASSIGNMENT_FIXTURE, languageVersion, true, ts.ScriptKind.TS)
      : defaultGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);

  return {
    fixturePath,
    program: ts.createProgram({ rootNames: [fixturePath], options, host }),
  };
}

function rejectedRawAssignments(): string[] {
  const { program, fixturePath } = createFixtureProgram();
  const fixture = program.getSourceFile(fixturePath);
  if (fixture === undefined) throw new Error('Canonical work-dir raw-assignment fixture was not compiled.');
  const carrierByLine = new Map<number, string>();
  RAW_ASSIGNMENT_FIXTURE.split('\n').forEach((line, index) => {
    const marker = line.match(/@carrier\s+(.+)$/u);
    if (marker?.[1] !== undefined) carrierByLine.set(index + 1, marker[1]);
  });

  return ts
    .getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.file?.fileName === fixturePath && diagnostic.start !== undefined)
    .map((diagnostic) => {
      const line = fixture.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1;
      return carrierByLine.get(line);
    })
    .filter((carrier): carrier is string => carrier !== undefined)
    .sort();
}

describe('canonical work-directory carrier closure', () => {
  it('names CanonicalWorkDir on every public and internal carrier owned by AC10', () => {
    const violations = REQUIRED_SOURCE_CARRIERS.flatMap(({ carrier, file, pattern }) => {
      const source = readFileSync(resolve(REPO_ROOT, file), 'utf8');
      return pattern.test(source) ? [] : [`${carrier} in ${file}`];
    });

    expect(violations).toEqual([]);
  });

  it('contains no brand-erasing plain-string cwd/workDir carrier in the workflow closure', () => {
    const violations = WORKFLOW_CLOSURE.flatMap((file) => {
      const source = readFileSync(resolve(REPO_ROOT, file), 'utf8');
      const plain = source.match(/\b(?:cwd|workDir)\??:\s*string\b/gu) ?? [];
      return plain.map((declaration) => `${file}: ${declaration}`);
    });

    expect(violations).toEqual([]);
  });

  it('does not manufacture the brand with a type assertion', () => {
    const production = [...REQUIRED_SOURCE_CARRIERS.map(({ file }) => file), ...WORKFLOW_CLOSURE].filter(
      (file, index, all) => all.indexOf(file) === index,
    );
    const violations = production.filter((file) =>
      /\bas\s+(?:unknown\s+as\s+)?CanonicalWorkDir\b/u.test(readFileSync(resolve(REPO_ROOT, file), 'utf8')),
    );

    expect(violations).toEqual([]);
  });

  it('rejects raw string assignment independently for every exported branded carrier', () => {
    const expected = RAW_ASSIGNMENT_FIXTURE.split('\n')
      .map((line) => line.match(/@carrier\s+(.+)$/u)?.[1])
      .filter((carrier): carrier is string => carrier !== undefined)
      .sort();

    expect(rejectedRawAssignments()).toEqual(expected);
  }, 60_000);
});
