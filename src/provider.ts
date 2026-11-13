// A fake refund provider. It holds an in-memory ledger of money "moved" and lets a
// test inject faults per call. It is not modelled on any real provider's API.

export type Fault =
  | "ok"
  | "timeout_before" // request never reaches the provider, caller sees a timeout
  | "http_500" // provider rejects, nothing moved
  | "timeout_after_success" // money moves, but the response is lost
  | "crash_after_success"; // money moves, then the caller's process dies

export class ProviderTimeout extends Error {}
export class ProviderError extends Error {}
/** Simulated process death. Callers must not catch it; tests treat it as a restart. */
export class CrashError extends Error {}
export class IdempotencyConflict extends Error {}

export interface RefundRequest {
  paymentId: string;
  amountCents: number;
  idempotencyKey?: string;
}

export interface Movement {
  ref: string;
  paymentId: string;
  amountCents: number;
  idempotencyKey?: string;
}

export class FakeRefundProvider {
  readonly moved: Movement[] = [];
  calls = 0;
  private seq = 0;
  private queue: Fault[] = [];
  private random: (() => Fault) | null = null;
  private byKey = new Map<string, { req: RefundRequest; ref: string }>();

  /** Faults are consumed one per call, in order. */
  inject(...faults: Fault[]): void {
    this.queue.push(...faults);
  }

  /** After the queue is empty, draw each call's fault from this function. */
  setRandomFaults(fn: (() => Fault) | null): void {
    this.random = fn;
  }

  totalMoved(paymentId?: string): number {
    return this.moved
      .filter((m) => paymentId === undefined || m.paymentId === paymentId)
      .reduce((s, m) => s + m.amountCents, 0);
  }

  async refund(req: RefundRequest): Promise<{ ref: string }> {
    this.calls++;
    await new Promise((r) => setImmediate(r)); // let other tasks interleave
    const fault = this.queue.shift() ?? this.random?.() ?? "ok";
    if (fault === "timeout_before") throw new ProviderTimeout("timeout");
    if (fault === "http_500") throw new ProviderError("500");

    let ref: string;
    const key = req.idempotencyKey;
    const seen = key ? this.byKey.get(key) : undefined;
    if (seen) {
      if (seen.req.paymentId !== req.paymentId || seen.req.amountCents !== req.amountCents) {
        throw new IdempotencyConflict("key reused with different parameters");
      }
      ref = seen.ref; // replay: return the original result, move nothing
    } else {
      ref = `fake_re_${++this.seq}`;
      this.moved.push({ ref, paymentId: req.paymentId, amountCents: req.amountCents, idempotencyKey: key });
      if (key) this.byKey.set(key, { req: { ...req }, ref });
    }
    if (fault === "timeout_after_success") throw new ProviderTimeout("timeout after success");
    if (fault === "crash_after_success") throw new CrashError("process died");
    return { ref };
  }
}
