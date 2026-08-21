import { containsWorkDir, type CanonicalWorkDir } from '../runtime/canonical-work-dir.js';
import type { JobKind } from './records.js';

// Explicitly naming a job id permits containment; ambient selection requires equality.
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
