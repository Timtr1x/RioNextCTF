/** Minimal counting semaphore for shared async resources (provider calls). */
export class Semaphore {
  private inFlight = 0;
  private readonly queue: (() => void)[] = [];

  constructor(private readonly capacity: number) {}

  async acquire(): Promise<void> {
    if (this.inFlight < this.capacity) {
      this.inFlight += 1;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.inFlight += 1;
  }

  release(): void {
    this.inFlight -= 1;
    const next = this.queue.shift();
    if (next) next();
  }

  get active(): number {
    return this.inFlight;
  }
}
