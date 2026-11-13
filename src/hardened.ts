import type { Db } from "./db.js";
import { CrashError, IdempotencyConflict, type FakeRefundProvider } from "./provider.js";
import type { RefundInput, RefundResult } from "./baseline.js";

export class KeyReuseError extends Error {}
class Rollback extends Error {}

interface RefundRow {
  id: number;
  payment_id: string;
  request_key: string;
  amount_cents: number;
  status: "pending" | "succeeded" | "failed";
  provider_ref: string | null;
}

const MAX_ATTEMPTS = 3;

/**
 * Hardened flow:
 *  1. In one transaction, insert a 'pending' refund row (unique on payment + request key)
 *     and reserve the amount with an atomic conditional UPDATE. A repeated request finds
 *     the existing row instead of creating a second one. Two racing requests cannot both
 *     reserve the same balance.
 *  2. Call the provider with an idempotency key derived from the row id, so any retry,
 *     including one after a crash, is a replay and moves no extra money.
 *  3. Finalise the row with a guarded UPDATE (only from 'pending'), so finalising twice
 *     cannot count the money twice.
 *  4. reconcile() finishes any row left 'pending' by a crash or a run of provider errors.
 */
export async function refundHardened(db: Db, provider: FakeRefundProvider, input: RefundInput): Promise<RefundResult> {
  const row = await reserve(db, input);
  if (!row) return { status: "rejected" };
  return drive(db, provider, row);
}

async function reserve(db: Db, input: RefundInput): Promise<RefundRow | null> {
  try {
    return await db.transaction(async (tx) => {
      const ins = await tx.query<RefundRow>(
        `insert into refunds (payment_id, request_key, amount_cents, status)
         values ($1,$2,$3,'pending') on conflict (payment_id, request_key) do nothing returning *`,
        [input.paymentId, input.requestKey, input.amountCents],
      );
      if (ins.rows[0]) {
        const upd = await tx.query(
          `update payments set reserved_cents = reserved_cents + $2
           where id=$1 and reserved_cents + $2 <= amount_cents returning id`,
          [input.paymentId, input.amountCents],
        );
        if (!upd.rows[0]) throw new Rollback(); // undo the inserted row too
        return ins.rows[0];
      }
      const ex = await tx.query<RefundRow>("select * from refunds where payment_id=$1 and request_key=$2", [
        input.paymentId,
        input.requestKey,
      ]);
      const existing = ex.rows[0]!;
      if (existing.amount_cents !== input.amountCents) throw new KeyReuseError("request key reused with a different amount");
      return existing;
    });
  } catch (e) {
    if (e instanceof Rollback) return null;
    throw e;
  }
}

async function drive(db: Db, provider: FakeRefundProvider, row: RefundRow): Promise<RefundResult> {
  if (row.status === "succeeded") return { status: "succeeded", providerRef: row.provider_ref ?? undefined };
  if (row.status === "failed") return { status: "failed" };

  const key = `refund:${row.id}`;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const { ref } = await provider.refund({
        paymentId: row.payment_id,
        amountCents: row.amount_cents,
        idempotencyKey: key,
      });
      await finalise(db, row, ref);
      return { status: "succeeded", providerRef: ref };
    } catch (e) {
      if (e instanceof CrashError || e instanceof IdempotencyConflict) throw e;
      // timeout or 5xx: safe to retry because the key makes a retry a replay
    }
  }
  return { status: "pending" }; // left for reconcile()
}

async function finalise(db: Db, row: RefundRow, ref: string): Promise<void> {
  await db.transaction(async (tx) => {
    const u = await tx.query(
      "update refunds set status='succeeded', provider_ref=$2 where id=$1 and status='pending' returning id",
      [row.id, ref],
    );
    if (u.rows[0]) {
      await tx.query("update payments set refunded_cents = refunded_cents + $2 where id=$1", [row.payment_id, row.amount_cents]);
    }
  });
}

/** Drive every pending refund to completion. Returns how many were still pending after this pass. */
export async function reconcile(db: Db, provider: FakeRefundProvider): Promise<number> {
  const pending = await db.query<RefundRow>("select * from refunds where status='pending' order by id");
  let left = 0;
  for (const row of pending.rows) {
    const r = await drive(db, provider, row);
    if (r.status === "pending") left++;
  }
  return left;
}
