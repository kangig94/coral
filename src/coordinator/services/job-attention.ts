export type AttentionExecution = Readonly<{ jobId: string; execution: number }>;

export class JobAttention {
  private readonly waits = new Map<string, number>();
  private readonly released = new Set<string>();

  private key(jobId: string, execution: number): string { return `${jobId}:${execution}`; }

  requested(jobId: string, execution: number): void {
    this.released.delete(this.key(jobId, execution));
  }

  beginWait(executions: readonly AttentionExecution[]): () => void {
    const keys = [...new Set(executions.map(({ jobId, execution }) => this.key(jobId, execution)))];
    for (const key of keys) this.waits.set(key, (this.waits.get(key) ?? 0) + 1);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      for (const key of keys) {
        const remaining = (this.waits.get(key) ?? 1) - 1;
        if (remaining === 0) this.waits.delete(key);
        else this.waits.set(key, remaining);
      }
    };
  }

  release(jobId: string, execution: number): void {
    this.released.add(this.key(jobId, execution));
  }

  isReleased(jobId: string, execution: number): boolean {
    return this.released.has(this.key(jobId, execution));
  }

  isUnwaited(jobId: string, execution: number): boolean {
    const key = this.key(jobId, execution);
    return !this.waits.has(key) && !this.released.has(key);
  }
}
