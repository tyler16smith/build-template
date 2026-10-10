/** Where one reply's time went, in milliseconds from the moment the turn started. */
export type TurnTimings = {
  /** Session, membership and budget: the checks the model waits for. */
  readyMs: number;
  /** The first streamed token, text or reasoning. */
  firstTokenMs: number | null;
  /** Each model step's duration, tool execution included. */
  stepsMs: number[];
  tools: { name: string; ms: number; ok: boolean }[];
  totalMs: number;
};

/**
 * Times one turn (ported from Custombase). The finished record goes into the reply's log line,
 * so a slow reply can be taken apart without guessing which phase was slow.
 */
export class TurnTimer {
  private readonly startedAt: number;
  private stepStartedAt: number | null = null;
  private readonly timings: Omit<TurnTimings, "totalMs">;

  constructor(now = Date.now()) {
    this.startedAt = now;
    this.timings = { readyMs: 0, firstTokenMs: null, stepsMs: [], tools: [] };
  }

  private since(): number {
    return Date.now() - this.startedAt;
  }

  ready() {
    this.timings.readyMs = this.since();
  }

  chunk() {
    if (this.timings.firstTokenMs === null) this.timings.firstTokenMs = this.since();
  }

  stepStart() {
    this.stepStartedAt = Date.now();
  }

  stepEnd() {
    if (this.stepStartedAt === null) return;
    this.timings.stepsMs.push(Date.now() - this.stepStartedAt);
    this.stepStartedAt = null;
  }

  async tool<T>(name: string, run: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    let ok = false;
    try {
      const result = await run();
      ok = true;
      return result;
    } finally {
      this.timings.tools.push({ name, ms: Date.now() - startedAt, ok });
    }
  }

  finish(): TurnTimings {
    return { ...this.timings, totalMs: this.since() };
  }
}
