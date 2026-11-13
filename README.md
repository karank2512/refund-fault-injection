# refund-fault-injection

A small, generic demo of how a refund flow breaks under ordinary faults, and what a hardened version does about it. TypeScript, Postgres semantics (tests run on PGlite, a WASM build of real Postgres, so no server or Docker is needed).

It is a standalone resilience exercise. It uses a **fake refund provider written for this repo**. No real payments, no real keys, no network calls. It is not modelled on any particular company's product or API and makes no claim about any real system.

## Run it

```
npm install
npm test        # typecheck + all tests, about a minute
npm run demo    # prints the naive vs hardened comparison table
```

`TRIALS=150 npm test` runs a longer random sweep (default 40 seeds per variant).

## What it compares

`src/baseline.ts` is the version most people write first: check the balance, call the provider, record the result.
`src/hardened.ts` is the same feature with the failure modes handled.

| Scenario | Fault injected | Naive result | Hardened result |
|---|---|---|---|
| duplicate-request | same refund request sent twice | refunds twice (8000 for a 4000 request) | once |
| timeout-after-success | provider moves money, response is lost, caller retries | refunds twice, database shows one | once, recorded |
| concurrent-over-refund | two 7000 refunds race on a 10000 payment | 14000 refunded on a 10000 payment | one succeeds, one rejected |
| crash-after-provider-call | process dies after money moved, before the DB write; client retries | refunds twice, database shows one | recovered by reconcile, once |
| transient-5xx (control) | provider returns 500 twice | fine | fine (no regression) |

Amounts are cents.

## How the hardened version works

1. **Reserve first.** One transaction inserts a `pending` refund row (unique on payment + request key) and reserves the amount with an atomic conditional `UPDATE`. A repeat finds the existing row. Racing requests cannot reserve the same balance.
2. **Idempotency key to the provider**, derived from the row id. Any retry, including after a crash, is a replay that moves no extra money.
3. **Guarded finalise.** `pending -> succeeded` only once, and the payment total is bumped in the same transaction, so finalising twice cannot double count.
4. **`reconcile()`** finishes rows left `pending` by a crash or a run of provider errors.
5. **Database constraints** (`reserved <= amount`, `refunded <= reserved`) as a last line of defence.
6. A request key reused with a different amount is rejected rather than silently applied.

## How it is tested

- `test/scenarios.test.ts`: each scenario, both variants. The naive version must break (the fault is really reproduced), the hardened version must hold every invariant, the control must pass in both.
- `test/units.test.ts`: fake provider semantics, pending-then-reconcile, key reuse, rejected over-refund leaves nothing behind, DB constraint.
- `test/random.test.ts`: seeded random fault sweep (timeouts, 5xx, lost responses, crashes, concurrent pairs, client retries). Hardened invariants must hold on every seed: never more than the payment, provider total equals database total, no pending rows left, no refund moved twice. The same seeds against the naive version report how many runs break.
- Mutation check done by hand: removing the idempotency key, or removing the balance guard, from the hardened code makes the matching scenario tests fail.

## Limits, stated plainly

- The fake provider is a simplified model: idempotency keys are remembered forever and replays return the first result. Real providers differ.
- PGlite is a single connection. Concurrency tests interleave async operations rather than using parallel database sessions. The hardened code is written for real Postgres (unique index, `ON CONFLICT`, atomic conditional update), but this repo does not test parallel sessions.
- One payment, partial refunds, one currency. No auth, no webhooks, no provider-side refund failure after acceptance.
