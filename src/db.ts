import { PGlite } from "@electric-sql/pglite";

export type Db = PGlite;

/**
 * The naive schema has no uniqueness on request keys and no reservation column.
 * The hardened schema adds both, plus CHECK constraints as a last line of defence.
 */
export async function createDb(hardened: boolean): Promise<Db> {
  const db = new PGlite();
  await db.exec(`
    create table payments (
      id text primary key,
      amount_cents integer not null,
      refunded_cents integer not null default 0
      ${hardened ? ", reserved_cents integer not null default 0, check (reserved_cents <= amount_cents), check (refunded_cents <= reserved_cents)" : ""}
    );
    create table refunds (
      id serial primary key,
      payment_id text not null references payments(id),
      request_key text not null,
      amount_cents integer not null,
      status text not null,
      provider_ref text
    );
    ${hardened ? "create unique index refunds_payment_key on refunds (payment_id, request_key);" : ""}
  `);
  return db;
}

export async function seedPayment(db: Db, id: string, amountCents: number): Promise<void> {
  await db.query("insert into payments (id, amount_cents) values ($1, $2)", [id, amountCents]);
}

export interface Snapshot {
  refundedCents: number;
  succeededCents: number;
  pending: number;
  rows: number;
}

export async function snapshot(db: Db, paymentId: string): Promise<Snapshot> {
  const p = await db.query<{ refunded_cents: number }>("select refunded_cents from payments where id=$1", [
    paymentId,
  ]);
  const r = await db.query<{ succeeded: string; pending: string; n: string }>(
    `select coalesce(sum(amount_cents) filter (where status='succeeded'),0) as succeeded,
            count(*) filter (where status='pending') as pending, count(*) as n
     from refunds where payment_id=$1`,
    [paymentId],
  );
  const row = r.rows[0]!;
  return {
    refundedCents: p.rows[0]?.refunded_cents ?? 0,
    succeededCents: Number(row.succeeded),
    pending: Number(row.pending),
    rows: Number(row.n),
  };
}
