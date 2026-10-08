export class JobAttention {
  private readonly waits = new Map<string, number>();
  private readonly released = new Set<string>();

  beginWait(jobIds: readonly string[]): () => void {
    for (const jobId of jobIds) this.waits.set(jobId, (this.waits.get(jobId) ?? 0) + 1);
    return () => {
      for (const jobId of jobIds) {
        const remaining = (this.waits.get(jobId) ?? 1) - 1;
        if (remaining === 0) this.waits.delete(jobId);
        else this.waits.set(jobId, remaining);
      }
    };
  }

  release(jobId: string): void {
    this.released.add(jobId);
  }

  isReleased(jobId: string): boolean {
    return this.released.has(jobId);
  }

  isUnwaited(jobId: string): boolean {
    return !this.waits.has(jobId) && !this.released.has(jobId);
  }
}
