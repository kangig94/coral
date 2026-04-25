import type { ZodError, ZodIssue } from 'zod';

export function formatZodError(error: ZodError): { message: string; detail: { issues: ZodIssue[] } } {
  const first = error.issues[0];
  const path = first?.path.join('.') ?? '';
  const head = first ? (path.length > 0 ? `${path}: ${first.message}` : first.message) : 'invalid request';
  const extras = error.issues.length - 1;
  return {
    message: extras > 0 ? `${head} (+${extras} more issues)` : head,
    detail: { issues: error.issues },
  };
}
