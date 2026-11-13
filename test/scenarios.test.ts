import test from "node:test";
import assert from "node:assert/strict";
import { scenarios } from "../src/scenarios.js";

const control = (n: string) => n.includes("control");

for (const s of scenarios) {
  test(`${s.name}: hardened holds every invariant`, async () => {
    const o = await s.run("hardened");
    assert.deepEqual(o.violations, []);
  });
  test(`${s.name}: naive ${control(s.name) ? "also holds (control)" : "reproduces the fault"}`, async () => {
    const o = await s.run("baseline");
    if (control(s.name)) assert.deepEqual(o.violations, []);
    else assert.ok(o.violations.length > 0, "expected the naive version to break");
  });
}

test("naive numbers are the expected ones", async () => {
  const by = Object.fromEntries(scenarios.map((s) => [s.name, s]));
  assert.equal((await by["duplicate-request"]!.run("baseline")).movedCents, 8000);
  assert.equal((await by["timeout-after-success"]!.run("baseline")).movedCents, 8000);
  assert.equal((await by["concurrent-over-refund"]!.run("baseline")).movedCents, 14000);
  const crash = await by["crash-after-provider-call"]!.run("baseline");
  assert.equal(crash.movedCents, 8000);
  assert.equal(crash.db.succeededCents, 4000);
});
