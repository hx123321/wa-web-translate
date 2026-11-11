import assert from "node:assert/strict";
import { WorkerTransport } from "../src/content/worker-transport";
import {
  receivedTranslationError,
  safeTranslationError,
} from "../src/shared/errors";
import { transientFailure } from "../src/background/retry";
export function runWorkerTransportTests(): number {
  let count = 0;
  const check = (name: string, fn: () => void) => {
    fn();
    count++;
    console.log("PASS", name);
  };
  const req = (id: string) =>
    ({
      __waTrans: true,
      kind: "TRANSLATE_REQUEST",
      id,
      payload: { text: "SYNTHETIC_PRIVATE_BODY", source: "auto", target: "fr" },
      revision: "r",
    }) as any;
  const fixture = () => {
    const events: any[] = [];
    const messages: any[] = [];
    const disconnects: (() => void)[] = [];
    const results: ((m: any) => void)[] = [];
    let throws = false,
      connects = 0;
    const port: any = {
      postMessage: (m: any) => {
        if (throws) throw new Error("Invalidated SECRET");
        messages.push(m);
      },
      onMessage: { addListener: (f: any) => results.push(f) },
      onDisconnect: { addListener: (f: any) => disconnects.push(f) },
      disconnect: () => disconnects.forEach((f) => f()),
    };
    const transport = new WorkerTransport(
      () => {
        connects++;
        return port;
      },
      (m) => events.push(m),
    );
    return {
      transport,
      events,
      messages,
      results,
      disconnects,
      throwPost: () => (throws = true),
      connects: () => connects,
    };
  };
  check(
    "Invalidated extension bridge reports bridge, never provider network or request replay",
    () => {
      const events: any[] = [];
      let attempts = 0;
      const t = new WorkerTransport(
        () => {
          attempts++;
          throw new Error("Extension context invalidated SECRET");
        },
        (m) => events.push(m),
      );
      t.prime();
      t.post(req("one"));
      assert.equal(attempts, 2);
      assert.equal(events[0].code, "bridge");
      const safe = safeTranslationError(
        receivedTranslationError(events[0].code),
      );
      assert.equal(safe.code, "bridge");
      assert(!transientFailure(receivedTranslationError("bridge")));
      assert(!JSON.stringify(events).includes("SECRET"));
      assert(!JSON.stringify(events).includes("SYNTHETIC_PRIVATE_BODY"));
    },
  );
  check(
    "Disconnect fails pending requests once without resending and ignores late old-port results",
    () => {
      const f = fixture();
      f.transport.post(req("a"));
      f.transport.post(req("b"));
      f.disconnects[0]();
      assert.equal(f.events.length, 2);
      assert.equal(f.messages.length, 2);
      f.results[0]({
        kind: "TRANSLATE_RESULT",
        id: "a",
        ok: true,
        result: { translated: "late" },
      });
      assert.equal(f.events.length, 2);
      f.transport.post(req("c"));
      assert.equal(f.connects(), 2);
      assert.equal(f.messages.length, 3);
    },
  );
  check(
    "Synchronous dispatch failure aborts dead-port queue without retrying uncertain payloads",
    () => {
      const f = fixture();
      f.transport.post(req("a"));
      f.throwPost();
      f.transport.post(req("b"));
      assert.equal(f.messages.length, 1);
      assert.equal(f.connects(), 1);
      assert.deepEqual(
        f.events.map((e) => e.id),
        ["a", "b"],
      );
    },
  );
  check(
    "Provider network result remains network; cancellation/disposal cannot emit stale result",
    () => {
      const f = fixture();
      f.transport.post(req("a"));
      f.results[0]({
        __waTrans: true,
        kind: "TRANSLATE_RESULT",
        id: "a",
        ok: false,
        code: "network",
        error: "safe",
      });
      assert.equal(f.events[0].code, "network");
      f.transport.post(req("b"));
      f.transport.post({ __waTrans: true, kind: "TRANSLATE_CANCEL", id: "b" });
      f.results[0]({ kind: "TRANSLATE_RESULT", id: "b", ok: true });
      assert.equal(f.events.length, 1);
      f.transport.post(req("c"));
      f.transport.dispose();
      assert.equal(f.events.length, 1);
    },
  );
  return count;
}
