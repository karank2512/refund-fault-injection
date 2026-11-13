import { createDb, seedPayment, snapshot, type Db, type Snapshot } from "./db.js";
import { FakeRefundProvider, CrashError } from "./provider.js";
import { refundBaseline, type RefundInput, type RefundResult } from "./baseline.js";
import { refundHardened, reconcile } from "./hardened.js";

export type Variant = "baseline" | "hardened";

export interface World {
  variant: Variant;
  db: Db;
  provider: FakeRefundProvider;
  paymentId: string;
  paymentCents: number;
  refund(input: Omit<RefundInput, "paymentId">): Promise<RefundResult>;
  /** Simulated restart: runs recovery. Baseline has none. */
  restart(): Promise<void>;
}

export async function makeWorld(variant: Variant, paymentCents = 10_000): Promise<World> {
  const db = await createDb(variant === "hardened");
  const provider = new FakeRefundProvider();
  const paymentId = "pay_1";
  await seedPayment(db, paymentId, paymentCents);
  const fn = variant === "hardened" ? refundHardened : refundBaseline;
  return {
    variant,
    db,
    provider,
    paymentId,
    paymentCents,
    refund: (i) => fn(db, provider, { ...i, paymentId }),
    restart: async () => {
      if (variant === "hardened") {
        for (let i = 0; i < 25 && (await reconcile(db, provider)) > 0; i++);
      }
    },
  };
}

/** Run an operation; a simulated crash is swallowed, as a restart would. */
export async function surviving<T>(p: Promise<T>): Promise<T | "crashed"> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof CrashError) return "crashed";
    throw e;
  }
}

export interface Outcome {
  movedCents: number;
  expectedMovedCents: number;
  db: Snapshot;
  violations: string[];
}

export async function judge(w: World, expectedMovedCents: number): Promise<Outcome> {
  const db = await snapshot(w.db, w.paymentId);
  const movedCents = w.provider.totalMoved(w.paymentId);
  const violations: string[] = [];
  if (movedCents > w.paymentCents) violations.push(`refunded ${movedCents} on a ${w.paymentCents} payment`);
  if (movedCents !== expectedMovedCents) violations.push(`provider moved ${movedCents}, expected ${expectedMovedCents}`);
  if (movedCents !== db.succeededCents) violations.push(`provider moved ${movedCents} but database records ${db.succeededCents}`);
  if (db.pending > 0) violations.push(`${db.pending} refund(s) stuck pending`);
  return { movedCents, expectedMovedCents, db, violations };
}
