#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const ALLOWED_WORKSPACE_ROOTS = new Set(['clients', 'docs', 'scripts', 'src', 'tests', 'tools']);
const ALLOWED_ROOT_FILES = new Set(['package.json']);
const CODE_TOKEN_PATTERN = /`([^`\r\n]+)`/g;
const MARKDOWN_LINK_PATTERN =
  /!?\[[^\]\r\n]*\]\(\s*(?:<([^>\r\n]+)>|([^\s)\r\n]+))(?:\s+(?:"[^"\r\n]*"|'[^'\r\n]*'))?\s*\)/g;
const LINE_SUFFIX_PATTERN = /^(.*):(\d+)(?:-(\d+))?$/;

const verificationInputSchema = z
  .object({
    planText: z.string(),
    workspace: z.string().trim().min(1),
  })
  .strict();

const cliArgumentsSchema = z
  .union([
    z.tuple([z.string().trim().min(1)]),
    z.tuple([z.string().trim().min(1), z.literal('--workspace'), z.string().trim().min(1)]),
  ])
  .transform(([planPath, , workspace]) => ({
    planPath,
    workspace: workspace ?? process.cwd(),
  }));

function extractCitationTargets(planText) {
  const targets = [];

  for (const match of planText.matchAll(CODE_TOKEN_PATTERN)) {
    if (LINE_SUFFIX_PATTERN.test(match[1])) {
      targets.push(match[1]);
    }
  }

  for (const match of planText.matchAll(MARKDOWN_LINK_PATTERN)) {
    const target = match[1] ?? match[2];
    if (LINE_SUFFIX_PATTERN.test(target)) {
      targets.push(target);
    }
  }

  return targets;
}

function parseCitationTarget(citation) {
  const match = LINE_SUFFIX_PATTERN.exec(citation);
  if (!match) {
    throw new Error(`Citation target does not have a line suffix: ${citation}`);
  }

  return {
    path: match[1],
    startLine: Number(match[2]),
    endLine: Number(match[3] ?? match[2]),
  };
}

function hasTraversal(filePath) {
  return filePath.split(/[\\/]/).includes('..');
}

function isInsideWorkspace(workspace, targetPath) {
  const workspaceRelative = relative(workspace, targetPath);
  return (
    workspaceRelative === '' ||
    (workspaceRelative !== '..' && !workspaceRelative.startsWith(`..${sep}`) && !isAbsolute(workspaceRelative))
  );
}

function workspacePathRejection(filePath, workspace) {
  if (hasTraversal(filePath)) {
    return 'traversal';
  }

  if (isAbsolute(filePath)) {
    return null;
  }

  if (ALLOWED_ROOT_FILES.has(filePath)) {
    return null;
  }

  if (!filePath.includes('/')) {
    return existsSync(resolve(workspace, filePath)) ? 'unapproved-root' : 'shorthand-anchor';
  }

  const [root] = filePath.split('/');
  return ALLOWED_WORKSPACE_ROOTS.has(root) ? null : 'unapproved-root';
}

function resolveCitationPath(filePath, workspace) {
  const candidate = isAbsolute(filePath) ? resolve(filePath) : resolve(workspace, filePath);

  try {
    return realpathSync(candidate);
  } catch {
    return null;
  }
}

function countFileLines(filePath) {
  const contents = readFileSync(filePath, 'utf8');
  if (contents.length === 0) {
    return 0;
  }

  const lines = contents.split(/\r\n|\r|\n/);
  return lines.length - (lines.at(-1) === '' ? 1 : 0);
}

function rejectionForCitation(citation, workspace) {
  const parsed = parseCitationTarget(citation);
  const pathRejection = workspacePathRejection(parsed.path, workspace);
  if (pathRejection) {
    return pathRejection;
  }

  if (parsed.startLine === 0 || parsed.endLine === 0) {
    return 'zero-line';
  }

  if (parsed.startLine > parsed.endLine) {
    return 'reversed-range';
  }

  const realTarget = resolveCitationPath(parsed.path, workspace);
  if (realTarget === null) {
    return 'missing-path';
  }

  if (!isInsideWorkspace(workspace, realTarget)) {
    return 'outside-workspace';
  }

  try {
    if (!statSync(realTarget).isFile()) {
      return 'missing-path';
    }

    const lineCount = countFileLines(realTarget);
    return parsed.startLine > lineCount || parsed.endLine > lineCount ? 'out-of-range-line' : null;
  } catch {
    return 'missing-path';
  }
}

export function verifyPlanCitations(planText, options) {
  const input = verificationInputSchema.parse({ planText, workspace: options?.workspace });
  const workspace = realpathSync(resolve(input.workspace));
  const citations = extractCitationTargets(input.planText);
  const rejections = [];

  for (const citation of citations) {
    const rejectionClass = rejectionForCitation(citation, workspace);
    if (rejectionClass) {
      rejections.push({ citation, rejectionClass });
    }
  }

  return {
    checkedCount: citations.length,
    rejections,
  };
}

function runCli(rawArguments) {
  const { planPath, workspace } = cliArgumentsSchema.parse(rawArguments);
  const planText = readFileSync(resolve(planPath), 'utf8');
  const result = verifyPlanCitations(planText, { workspace });

  if (result.rejections.length > 0) {
    for (const rejection of result.rejections) {
      console.error(`${rejection.rejectionClass}: ${rejection.citation}`);
    }
    console.error(`Plan citation verification failed with ${result.rejections.length} rejection(s).`);
    return 1;
  }

  console.log(`Verified ${result.checkedCount} plan citation(s).`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = runCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error('Usage: node tools/verify-plan-citations.mjs <planPath> [--workspace <dir>]');
    process.exitCode = 1;
  }
}
