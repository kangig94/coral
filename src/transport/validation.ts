import type { ZodError, ZodIssue } from 'zod';

export function formatZodError(error: ZodError): { message: string; detail: { issues: ZodIssue[] } } {
  const first = error.issues[0];
  const path = first?.path.join('.') ?? '';
  let head = 'invalid request';
  if (first !== undefined) {
    head = path.length > 0 ? `${path}: ${first.message}` : first.message;
  }
  const extras = error.issues.length - 1;
  return {
    message: extras > 0 ? `${head} (+${extras} more issues)` : head,
    detail: { issues: error.issues },
  };
}
