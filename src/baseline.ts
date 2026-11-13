import type { Db } from "./db.js";
import { CrashError, type FakeRefundProvider } from "./provider.js";

export interface RefundInput {
  paymentId: string;
  amountCents: number;
  requestKey: string; // the caller's logical request id; the naive version ignores it
}
export type RefundResult = { status: "succeeded" | "pending" | "failed" | "rejected"; providerRef?: string };

/**
 * The version most people write first: check, call the provider, record.
 * Weaknesses, each exercised by a scenario:
 *  - no dedupe of repeated requests
 *  - check-then-act race on the refundable balance
 *  - retries a timed-out call with no idempotency key
 *  - provider call and DB write are not linked, so a crash between them loses the record
 */
export async function refundBaseline(db: Db, provider: FakeRefundProvider, input: RefundInput): Promise<RefundResult> {
  const p = await db.query<{ amount_cents: number; refunded_cents: number }>(
    "select amount_cents, refunded_cents from payments where id=$1",
    [input.paymentId],
  );
  const pay = p.rows[0];
  if (!pay || pay.refunded_cents + input.amountCents > pay.amount_cents) return { status: "rejected" };

  let ref: string | undefined;
  for (let attempt = 1; attempt <= 3 && !ref; attempt++) {
    try {
      ref = (await provider.refund({ paymentId: input.paymentId, amountCents: input.amountCents })).ref;
    } catch (e) {
      if (e instanceof CrashError) throw e;
    }
  }
  if (!ref) return { status: "failed" };

  await db.query(
    "insert into refunds (payment_id, request_key, amount_cents, status, provider_ref) values ($1,$2,$3,'succeeded',$4)",
    [input.paymentId, input.requestKey, input.amountCents, ref],
  );
  await db.query("update payments set refunded_cents = refunded_cents + $2 where id=$1", [input.paymentId, input.amountCents]);
  return { status: "succeeded", providerRef: ref };
}
