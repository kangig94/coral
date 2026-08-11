import ts from 'typescript';

/**
 * Blanks a literal's span so a lexical scan cannot see inside it. Newlines
 * survive so line numbers — and the line-anchored comment pattern below —
 * keep matching the original source.
 */
function blankSpan(text: string): string {
  return text.replace(/[^\n]/g, ' ');
}

function collectLiteralSpans(sourceFile: ts.SourceFile, node: ts.Node, spans: Array<[number, number]>): void {
  if (
    node.kind === ts.SyntaxKind.StringLiteral ||
    node.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
    node.kind === ts.SyntaxKind.RegularExpressionLiteral
  ) {
    spans.push([node.getStart(sourceFile), node.getEnd()]);
    return;
  }

  if (ts.isTemplateExpression(node)) {
    // Only the quoted fragments are payload. Interpolations are executable
    // code and stay visible to the scan.
    spans.push([node.head.getStart(sourceFile), node.head.getEnd()]);
    for (const span of node.templateSpans) {
      collectLiteralSpans(sourceFile, span.expression, spans);
      spans.push([span.literal.getStart(sourceFile), span.literal.getEnd()]);
    }
    return;
  }

  ts.forEachChild(node, (child) => collectLiteralSpans(sourceFile, child, spans));
}

/**
 * Returns `source` with every string, template and regular-expression literal
 * blanked and every comment removed, so an identifier scan reads executable
 * code only and never trips on a quoted name or a commented-out example.
 *
 * Literal spans come from the TypeScript parser rather than from quote-matching
 * patterns. A hand-rolled stripper cannot pair quotes correctly — an apostrophe
 * inside a double-quoted string desynchronizes every later quote in the file,
 * and the resulting unterminated template literal sent one scan into
 * exponential backtracking (a 712-line file never finished). Parser spans make
 * that class of failure inexpressible.
 */
export function codeTextOnly(source: string): string {
  const sourceFile = ts.createSourceFile('scan.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const spans: Array<[number, number]> = [];
  collectLiteralSpans(sourceFile, sourceFile, spans);
  spans.sort(([left], [right]) => left - right);

  let blanked = '';
  let cursor = 0;
  for (const [start, end] of spans) {
    blanked += source.slice(cursor, start) + blankSpan(source.slice(start, end));
    cursor = end;
  }
  blanked += source.slice(cursor);

  return blanked.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|\n)\s*\/\/[^\n]*/gu, '$1');
}
