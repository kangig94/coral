import { containsWorkDir, type CanonicalWorkDir } from '../runtime/canonical-work-dir.js';
import type { JobKind } from './records.js';

/**
 * How a caller's directory must relate to a job's work directory for the job to be in scope.
 * `contains` answers explicit addressing — naming a job id is deliberate, so an ancestor may reach it.
 * `exact` answers ambient selection, which nobody typed a job id for.
 */
export type JobScopeRelation = 'contains' | 'exact';

export type ScopeCheckResult = {
  valid: string[];
  missing: string[];
  mismatch: string[];
};

/** The two coordinates scope is judged on. `workDir` is null for exactly the KB jobs. */
export type JobScopeSubject = {
  readonly jobKind: JobKind;
  readonly workDir: CanonicalWorkDir | null;
};

export function jobInCallerScope(
  subject: JobScopeSubject,
  callerRoot: CanonicalWorkDir,
  relation: JobScopeRelation,
): boolean {
  // A KB job runs against the shared corpus and belongs to no single work directory.
  if (subject.jobKind === 'kb') return true;
  if (subject.workDir === null) return false;
  return relation === 'contains' ? containsWorkDir(callerRoot, subject.workDir) : callerRoot === subject.workDir;
}
