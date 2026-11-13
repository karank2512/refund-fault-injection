import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld, surviving, judge, type Variant } from "../src/harness.js";
import type { Fault } from "../src/provider.js";
import { snapshot } from "../src/db.js";

function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FAULTS: Fault[] = ["timeout_before", "http_500", "timeout_after_success", "crash_after_success"];

/** Seeded random workload: 8 requests over 5 keys, random faults, mixed concurrent and sequential, crashes, then restart + client retries. */
async function trial(variant: Variant, seed: number) {
  const rnd = mulberry32(seed);
  const w = await makeWorld(variant, 10_000);
  const amountFor = Array.from({ length: 5 }, () => 500 + Math.floor(rnd() * 3500));
  const reqs = Array.from({ length: 8 }, () => {
    const k = Math.floor(rnd() * 5);
    return { requestKey: `k${k}`, amountCents: amountFor[k]! };
  });
  w.provider.setRandomFaults(() => (rnd() < 0.4 ? FAULTS[Math.floor(rnd() * FAULTS.length)]! : "ok"));
  for (let i = 0; i < reqs.length; ) {
    const n = rnd() < 0.5 ? 1 : 2; // sometimes two at once
    const batch = reqs.slice(i, i + n);
    i += n;
    await Promise.all(batch.map((r) => surviving(w.refund(r))));
  }
  // Restart with a healthy provider, recover, then every client retries once.
  w.provider.setRandomFaults(null);
  await w.restart();
  for (const r of reqs) await surviving(w.refund(r));
  await w.restart();
  return w;
}

const TRIALS = Number(process.env.TRIALS ?? 40);

test(`hardened: ${TRIALS} seeded random fault runs, invariants always hold`, async () => {
  for (let seed = 1; seed <= TRIALS; seed++) {
    const w = await trial("hardened", seed);
    const s = await snapshot(w.db, w.paymentId);
    const moved = w.provider.totalMoved(w.paymentId);
    const ctx = `seed ${seed}`;
    assert.ok(moved <= w.paymentCents, `${ctx}: over-refunded`);
    assert.equal(moved, s.succeededCents, `${ctx}: provider vs database drift`);
    assert.equal(moved, s.refundedCents, `${ctx}: payment total drift`);
    assert.equal(s.pending, 0, `${ctx}: stuck pending`);
    const keys = w.provider.moved.map((m) => m.idempotencyKey);
    assert.equal(new Set(keys).size, keys.length, `${ctx}: a refund moved money twice`);
    const o = await judge(w, moved);
    assert.deepEqual(o.violations, [], ctx);
  }
});

test(`naive: same ${TRIALS} runs, count how many break (expect many)`, async () => {
  let broken = 0;
  for (let seed = 1; seed <= TRIALS; seed++) {
    const w = await trial("baseline", seed);
    const s = await snapshot(w.db, w.paymentId);
    const moved = w.provider.totalMoved(w.paymentId);
    if (moved > w.paymentCents || moved !== s.succeededCents) broken++;
  }
  console.log(`  naive: ${broken}/${TRIALS} runs over-refunded or drifted from the provider`);
  assert.ok(broken > TRIALS / 2, `only ${broken} naive runs broke`);
});
