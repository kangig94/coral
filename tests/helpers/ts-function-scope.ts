import ts from 'typescript';

/**
 * `ts.isFunctionLike` also admits signature declarations, which carry no body to scan; a scan that
 * accepts one has nothing to read and cannot report what it did not check.
 */
export function isFunctionScope(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}
