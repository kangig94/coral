import { randomUUID } from 'node:crypto';
import type { JobPhase, LaunchState } from '../types.js';

export interface JobEntry {
  jobId: string;
  sessionId: string;
  provider: string;
  controller: AbortController;
  phase: JobPhase;
  launchState: LaunchState;
  launchMessage?: string;
}

export type AbortResult = {
  aborted: string[];
  notFound: string[];
};

export class JobManager {
  private readonly jobs = new Map<string, JobEntry>();

  /** Allocate a new jobId and register it as 'launching'. Returns the new jobId. */
  allocate(sessionId: string, provider: string): string {
    const jobId = randomUUID();
    const entry: JobEntry = {
      jobId,
      sessionId,
      provider,
      controller: new AbortController(),
      phase: 'launching',
      launchState: 'pending',
    };
    this.jobs.set(jobId, entry);
    return jobId;
  }

  /** Update the launch bootstrap state. Used by awaitLaunch() polling. */
  setLaunchState(jobId: string, state: LaunchState, message?: string): void {
    const entry = this.jobs.get(jobId);
    if (!entry) return;
    entry.launchState = state;
    entry.launchMessage = message;
  }

  /** Advance job phase. */
  setPhase(jobId: string, phase: JobPhase): void {
    const entry = this.jobs.get(jobId);
    if (!entry) return;
    entry.phase = phase;
  }

  /** Get signal for a job. */
  getSignal(jobId: string): AbortSignal | null {
    return this.jobs.get(jobId)?.controller.signal ?? null;
  }

  /** Get full entry for a job. */
  get(jobId: string): JobEntry | null {
    return this.jobs.get(jobId) ?? null;
  }

  /** Returns true if job is in a non-terminal phase. */
  isActive(jobId: string): boolean {
    const entry = this.jobs.get(jobId);
    if (!entry) return false;
    return entry.phase === 'launching' || entry.phase === 'running';
  }

  /** Abort specific jobs. Returns which were found and aborted vs not found. */
  abort(jobIds: string[]): AbortResult {
    const aborted: string[] = [];
    const notFound: string[] = [];
    for (const jobId of jobIds) {
      const entry = this.jobs.get(jobId);
      if (!entry) {
        notFound.push(jobId);
        continue;
      }
      entry.controller.abort();
      aborted.push(jobId);
    }
    return { aborted, notFound };
  }

  /** Remove a completed job from the in-memory map. Call after terminal phase is persisted. */
  remove(jobId: string): void {
    this.jobs.delete(jobId);
  }
}
