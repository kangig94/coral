import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { listProductionSourceFiles } from '#tests/helpers/ts-import-scanner.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const JOBS_ROOT = join(ROOT, 'src/jobs');
const RESULT_PATH = join(JOBS_ROOT, 'terminal', 'result.ts');

const TERMINAL_METADATA_FIELDS = ['exitCode', 'warnings', 'usage', 'workflow'] as const;

describe('job terminal shape invariant', () => {
  it('keeps JobTerminal as terminal content/outcome only', () => {
    const content = readFileSync(RESULT_PATH, 'utf-8');
    const interfaceMatch = content.match(/export interface JobTerminal \{(?<body>[\s\S]*?)\n\}/);
    const schemaMatch = content.match(
      /export const jobTerminalSchema = z\s+\.object\(\{(?<body>[\s\S]*?)\n\s{2}\}\)\s+\.strict\(\);/,
    );
    expect(interfaceMatch).not.toBeNull();
    expect(schemaMatch).not.toBeNull();

    const terminalInterface = interfaceMatch?.groups?.body ?? '';
    const terminalSchema = schemaMatch?.groups?.body ?? '';

    for (const field of TERMINAL_METADATA_FIELDS) {
      expect(terminalInterface).not.toContain(field);
      expect(terminalSchema).not.toContain(field);
    }
  });

  it('keeps workflow metadata out of job terminal diagnostics', () => {
    const content = readFileSync(RESULT_PATH, 'utf-8');
    const diagnosticsMatch = content.match(/export interface JobTerminalDiagnostics \{(?<body>[\s\S]*?)\n\}/);
    const diagnosticsSchemaMatch = content.match(
      /export const jobTerminalDiagnosticsSchema = z\s+\.object\(\{(?<body>[\s\S]*?)\n\s{2}\}\)\s+\.strict\(\);/,
    );
    const aggregateDiagnosticsSchemaMatch = content.match(
      /export const jobDiagnosticsSchema = jobTerminalDiagnosticsSchema\s+\.extend\(\{(?<body>[\s\S]*?)\n\s{2}\}\)\s+\.strict\(\);/,
    );
    expect(diagnosticsMatch).not.toBeNull();
    expect(diagnosticsSchemaMatch).not.toBeNull();
    expect(aggregateDiagnosticsSchemaMatch).not.toBeNull();
    expect(diagnosticsMatch?.groups?.body ?? '').not.toContain('workflow');
    expect(diagnosticsSchemaMatch?.groups?.body ?? '').not.toContain('workflow');
    expect(aggregateDiagnosticsSchemaMatch?.groups?.body ?? '').not.toContain('workflow');
  });

  it('does not read terminal metadata from JobTerminal instances in the jobs layer', () => {
    const violations: string[] = [];
    const forbidden = /\b(?:result|status\.result)\.(?:exitCode|warnings|usage|workflow)\b/;

    for (const filePath of listProductionSourceFiles(JOBS_ROOT)) {
      const content = readFileSync(filePath, 'utf-8');
      if (forbidden.test(content)) {
        violations.push(relative(ROOT, filePath).split('\\').join('/'));
      }
    }

    expect(violations).toEqual([]);
  });
});
