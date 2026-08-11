import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const REPO_ROOT = join(__dirname, '..', '..');
const PROTOCOL_FILE = join(REPO_ROOT, 'src/provider-proxy/protocol.ts');
const WIRE_CAP = 'PROXY_OPERATION_STATUS_MAX_OPERATIONS';
const LEDGER_CAP = 'MAX_PROXY_OPERATION_LEDGERS';

function variableInitializer(sourceFile: ts.SourceFile, name: string): ts.Expression | undefined {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
        return declaration.initializer;
      }
    }
  }
  return undefined;
}

describe('provider operation status bounds', () => {
  it('keeps the wire request cap a numeric literal independent of ledger capacity', () => {
    const source = readFileSync(PROTOCOL_FILE, 'utf-8');
    const sourceFile = ts.createSourceFile(PROTOCOL_FILE, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const initializer = variableInitializer(sourceFile, WIRE_CAP);
    const independenceMessage =
      `${WIRE_CAP} must be a plain numeric literal independent of ${LEDGER_CAP}; ` +
      'do not use an identifier, import alias, or arithmetic expression';

    expect(initializer, independenceMessage).toBeDefined();
    expect(initializer !== undefined && ts.isNumericLiteral(initializer), independenceMessage).toBe(true);
    if (initializer === undefined || !ts.isNumericLiteral(initializer)) return;
    expect(Number(initializer.text), `${WIRE_CAP} must remain 128`).toBe(128);
  });
});
