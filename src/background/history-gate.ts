// A forged page bridge cannot create an unbounded disk work queue. This is a
// resource limit, not authentication of page-world messages.
export class HistoryRequestGate {
  private active = 0;
  private starts: number[] = [];
  constructor(private now = Date.now) {}
  async run<T>(work: () => Promise<T>): Promise<T | { status: "busy" }> {
    const now = this.now();
    this.starts = this.starts.filter((t) => t > now - 60000);
    if (this.active >= 8 || this.starts.length >= 120)
      return { status: "busy" };
    this.active++;
    this.starts.push(now);
    try {
      return await work();
    } finally {
      this.active--;
    }
  }
}
