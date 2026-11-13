# refund-fault-injection

How a refund flow breaks under ordinary faults, and what it takes to make it hold. TypeScript, Postgres semantics, a fake provider, and a side-by-side run of a naive implementation against a hardened one.

This is a standalone resilience exercise. The provider is a **fake written for this repo**. There are no real payments, no keys, no network calls, and nothing here is modelled on any particular company's product or API.

```
$ npm run demo
scenario                   |  naive: moved / recorded  |  naive verdict                       |  hardened: moved / recorded  |  hardened verdict
duplicate-request          |  8000 / 8000 (want 4000)  |  FAIL: provider moved 8000, ...      |  4000 / 4000 (want 4000)     |  ok
timeout-after-success      |  8000 / 4000 (want 4000)  |  FAIL: provider moved 8000, ...      |  4000 / 4000 (want 4000)     |  ok
concurrent-over-refund     |  14000 / 14000 (want 7000)|  FAIL: refunded 14000 on a 10000 ... |  7000 / 7000 (want 7000)     |  ok
crash-after-provider-call  |  8000 / 4000 (want 4000)  |  FAIL: provider moved 8000, ...      |  4000 / 4000 (want 4000)     |  ok
transient-5xx (control)    |  4000 / 4000 (want 4000)  |  ok                                  |  4000 / 4000 (want 4000)     |  ok
```

Amounts are cents. Output is abbreviated here; run it for the full table.

## Run it

Requires Node 20 or newer. No database server or Docker: tests run on [PGlite](https://pglite.dev), Postgres compiled to WASM.

```
npm install
npm test          # typecheck + all tests, under a minute
npm run demo      # the comparison table above
npm run check     # lint + format check + typecheck + tests (what CI runs)
```

`TRIALS=150 npm test` runs a longer random sweep. The default is 40 seeds per variant.

## What it shows

`src/baseline.ts` is the version most people write first: check the balance, call the provider, record the result. `src/hardened.ts` is the same feature with the failure modes handled.

| Scenario                  | Fault injected                                                      | Naive                             | Hardened                         |
| ------------------------- | ------------------------------------------------------------------- | --------------------------------- | -------------------------------- |
| duplicate-request         | the same refund request arrives twice                               | refunds twice                     | once                             |
| timeout-after-success     | provider moves the money, the response is lost, the caller retries  | refunds twice, database shows one | once, recorded                   |
| concurrent-over-refund    | two 7000 refunds race on a 10000 payment                            | 14000 refunded on a 10000 payment | one succeeds, one is rejected    |
| crash-after-provider-call | process dies after money moved, before the DB write; client retries | refunds twice, database shows one | recovered by `reconcile()`, once |
| transient-5xx (control)   | provider returns 500 twice, then recovers                           | fine                              | fine, no regression              |

## Design notes

The hardened flow in `src/hardened.ts`:

1. **Reserve first.** One transaction inserts a `pending` refund row, unique on `(payment_id, request_key)`, and reserves the amount with an atomic conditional `UPDATE ... WHERE reserved + amount <= total`. A repeat request finds the existing row. Racing requests cannot reserve the same balance. If the reservation fails, the insert rolls back with it.
2. **Idempotency key to the provider**, derived from the row id. Any retry, including one after a crash, is a replay and moves no extra money.
3. **Guarded finalise.** `pending -> succeeded` happens at most once, and the payment total is updated in the same transaction, so finalising twice cannot double count.
4. **`reconcile()`** drives any row left `pending` (crash, or a run of provider errors) to completion. It is safe to run repeatedly.
5. **Database constraints** (`reserved <= amount`, `refunded <= reserved`) as a last line of defence.
6. **Key reuse with a different amount** is rejected rather than silently applied.

Why the order matters: the durable intent (the `pending` row) exists before any money can move, and the provider call is made safe to repeat. That turns "did it go through?" after a crash or timeout from a question with no answer into a retry that is always safe.

Layout:

```
src/provider.ts   fake provider with injectable faults and idempotency-key replay
src/db.ts         schema (naive and hardened variants) and snapshots
src/baseline.ts   naive refund flow
src/hardened.ts   hardened refund flow and reconcile()
src/harness.ts    builds a world per variant, judges invariants
src/scenarios.ts  the five named scenarios
src/demo.ts       prints the comparison table
test/             scenario, unit and seeded random-fault tests
```

## How it is tested

- `test/scenarios.test.ts` runs each scenario on both variants. The naive version must break (so the fault is really reproduced), the hardened version must hold every invariant, and the control must pass on both.
- `test/units.test.ts` covers the fake provider's semantics, pending-then-reconcile, key reuse, a rejected over-refund leaving no stray row or reservation, and the DB constraint.
- `test/random.test.ts` is a seeded random sweep: timeouts, 5xx, lost responses, crashes, concurrent pairs, client retries. Hardened invariants must hold on every seed: never more than the payment, provider total equals database total, no pending rows left, no refund moved twice. The same seeds run against the naive version and report how many runs break.
- Mutation check, done by hand: removing the idempotency key, or the balance guard, from the hardened code makes the matching scenario tests fail.

## Limits

- The fake provider is a simplified model: idempotency keys are remembered forever and a replay returns the first result. Real providers differ.
- PGlite is a single connection, so the concurrency tests interleave async operations rather than using parallel database sessions. The hardened code is written for real Postgres (unique index, `ON CONFLICT`, atomic conditional update), but this repo does not test parallel sessions.
- One payment, partial refunds, one currency. No auth, no webhooks, no provider-side failure after acceptance.
- It is a demonstration, not a payments library.
