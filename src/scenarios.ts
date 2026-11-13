import { judge, makeWorld, surviving, type Outcome, type Variant } from "./harness.js";

export interface Scenario {
  name: string;
  fault: string;
  run(variant: Variant): Promise<Outcome>;
}

export const scenarios: Scenario[] = [
  {
    name: "duplicate-request",
    fault: "client sends the same refund twice (double click, retry after a slow page)",
    async run(v) {
      const w = await makeWorld(v);
      await w.refund({ requestKey: "k1", amountCents: 4000 });
      await w.refund({ requestKey: "k1", amountCents: 4000 });
      return judge(w, 4000);
    },
  },
  {
    name: "timeout-after-success",
    fault: "provider moves the money but the response is lost; the caller retries",
    async run(v) {
      const w = await makeWorld(v);
      w.provider.inject("timeout_after_success");
      await w.refund({ requestKey: "k1", amountCents: 4000 });
      await w.restart();
      return judge(w, 4000);
    },
  },
  {
    name: "concurrent-over-refund",
    fault: "two 7000 refunds race on a 10000 payment",
    async run(v) {
      const w = await makeWorld(v);
      await Promise.all([
        w.refund({ requestKey: "k1", amountCents: 7000 }),
        w.refund({ requestKey: "k2", amountCents: 7000 }),
      ]);
      await w.restart();
      return judge(w, 7000);
    },
  },
  {
    name: "crash-after-provider-call",
    fault: "process dies after the provider moved money, before the database write; client retries after restart",
    async run(v) {
      const w = await makeWorld(v);
      w.provider.inject("crash_after_success");
      await surviving(w.refund({ requestKey: "k1", amountCents: 4000 }));
      await w.restart();
      await w.refund({ requestKey: "k1", amountCents: 4000 });
      return judge(w, 4000);
    },
  },
  {
    name: "transient-5xx (control)",
    fault: "provider returns 500 twice, then recovers. Nothing should go wrong in either version",
    async run(v) {
      const w = await makeWorld(v);
      w.provider.inject("http_500", "http_500");
      await w.refund({ requestKey: "k1", amountCents: 4000 });
      await w.restart();
      return judge(w, 4000);
    },
  },
];
