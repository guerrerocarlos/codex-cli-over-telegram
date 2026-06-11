export class RunQueue {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly depths = new Map<string, number>();
  private activeCount = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly maxParallelRuns: number) {}

  depth(key: string): number {
    return this.depths.get(key) ?? 0;
  }

  enqueue(key: string, task: () => Promise<void>): void {
    this.depths.set(key, this.depth(key) + 1);

    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        await this.acquireGlobalSlot();
        try {
          await task();
        } finally {
          this.releaseGlobalSlot();
          const nextDepth = Math.max(0, this.depth(key) - 1);
          if (nextDepth === 0) {
            this.depths.delete(key);
          } else {
            this.depths.set(key, nextDepth);
          }
        }
      });

    this.chains.set(
      key,
      next.finally(() => {
        if (this.chains.get(key) === next) {
          this.chains.delete(key);
        }
      }),
    );
  }

  private async acquireGlobalSlot(): Promise<void> {
    while (this.activeCount >= this.maxParallelRuns) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.activeCount += 1;
  }

  private releaseGlobalSlot(): void {
    this.activeCount = Math.max(0, this.activeCount - 1);
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter();
    }
  }
}
