/**
 * Return whether this exact CLI invocation owns the store-reset diagnostic
 * supervisor and therefore may translate process signals into an abort.
 */
export function isStoreResetReportInvocation(argv: readonly string[]): boolean {
  return argv[0] === 'backend' && argv[1] === 'store-reset' && argv[2] === 'report';
}
