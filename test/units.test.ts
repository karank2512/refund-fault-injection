import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld } from "../src/harness.js";
import { FakeRefundProvider, IdempotencyConflict, ProviderTimeout } from "../src/provider.js";
import { KeyReuseError } from "../src/hardened.js";
import { snapshot } from "../src/db.js";

test("provider: same idempotency key replays and moves nothing extra", async () => {
  const p = new FakeRefundProvider();
  const a = await p.refund({ paymentId: "x", amountCents: 5, idempotencyKey: "k" });
  const b = await p.refund({ paymentId: "x", amountCents: 5, idempotencyKey: "k" });
  assert.equal(a.ref, b.ref);
  assert.equal(p.totalMoved(), 5);
});

test("provider: key reused with other parameters is refused", async () => {
  const p = new FakeRefundProvider();
  await p.refund({ paymentId: "x", amountCents: 5, idempotencyKey: "k" });
  await assert.rejects(
    p.refund({ paymentId: "x", amountCents: 6, idempotencyKey: "k" }),
    IdempotencyConflict,
  );
});

test("provider: timeout_after_success really moves money", async () => {
  const p = new FakeRefundProvider();
  p.inject("timeout_after_success");
  await assert.rejects(p.refund({ paymentId: "x", amountCents: 5 }), ProviderTimeout);
  assert.equal(p.totalMoved(), 5);
});

test("provider: timeout_before and http_500 move nothing", async () => {
  const p = new FakeRefundProvider();
  p.inject("timeout_before", "http_500");
  await assert.rejects(p.refund({ paymentId: "x", amountCents: 5 }));
  await assert.rejects(p.refund({ paymentId: "x", amountCents: 5 }));
  assert.equal(p.totalMoved(), 0);
});

test("hardened: provider down for a whole call leaves a pending row; reconcile finishes it once", async () => {
  const w = await makeWorld("hardened");
  w.provider.inject("http_500", "http_500", "http_500");
  const r = await w.refund({ requestKey: "k1", amountCents: 3000 });
  assert.equal(r.status, "pending");
  assert.equal(w.provider.totalMoved(), 0);
  await w.restart();
  await w.restart();
  assert.equal(w.provider.totalMoved(), 3000);
  const s = await snapshot(w.db, w.paymentId);
  assert.deepEqual([s.refundedCents, s.succeededCents, s.pending], [3000, 3000, 0]);
});

test("hardened: same key with a different amount is rejected, not silently applied", async () => {
  const w = await makeWorld("hardened");
  await w.refund({ requestKey: "k1", amountCents: 3000 });
  await assert.rejects(w.refund({ requestKey: "k1", amountCents: 3500 }), KeyReuseError);
  assert.equal(w.provider.totalMoved(), 3000);
});

test("hardened: rejected over-refund leaves no stray row or reservation", async () => {
  const w = await makeWorld("hardened");
  const r = await w.refund({ requestKey: "k1", amountCents: 20_000 });
  assert.equal(r.status, "rejected");
  const s = await snapshot(w.db, w.paymentId);
  assert.equal(s.rows, 0);
  const res = await w.db.query<{ reserved_cents: number }>("select reserved_cents from payments");
  assert.equal(res.rows[0]!.reserved_cents, 0);
});

test("hardened: database itself refuses to refund more than the payment", async () => {
  const w = await makeWorld("hardened");
  await assert.rejects(w.db.query("update payments set reserved_cents = 99999"));
});
