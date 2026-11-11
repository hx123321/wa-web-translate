import assert from "node:assert/strict";
import { TranslationOperation } from "../src/background/retry";
import { httpError, TranslationError } from "../src/shared/errors";
import { translateService } from "../src/background/services";
export async function runRetryTests(): Promise<number> {
  let count = 0;
  const check = async (name: string, fn: () => Promise<void>) => {
    await fn();
    count++;
    console.log("PASS", name);
  };
  await check(
    "Transient failures retry once, successful chunks never replay",
    async () => {
      const old = globalThis.fetch;
      const calls: string[] = [];
      let secondFailed = false;
      const operation = new TranslationOperation(async () => {});
      try {
        globalThis.fetch = async (url) => {
          const text = new URL(String(url)).searchParams.get("q")!;
          calls.push(text);
          if (text === "b" && !secondFailed) {
            secondFailed = true;
            return new Response("private", { status: 503 });
          }
          return new Response(JSON.stringify([[[text]], null, "en"]));
        };
        const result = await translateService(
          "google",
          { text: "a".repeat(1000) + "b", target: "fr" },
          operation,
        );
        assert.equal(result.translated.length, 1001);
        assert.deepEqual(
          calls.map((x) => x.length),
          [1000, 1, 1],
        );
      } finally {
        globalThis.fetch = old;
        operation.dispose();
      }
    },
  );
  await check(
    "One retry budget is shared across operations and no permanent errors retry",
    async () => {
      const operation = new TranslationOperation(async () => {});
      let calls = 0;
      try {
        await assert.rejects(
          operation.run(async () => {
            calls++;
            throw new TypeError("Failed to fetch");
          }),
        );
        assert.equal(calls, 2);
        await assert.rejects(
          operation.run(async () => {
            calls++;
            throw httpError(503);
          }),
        );
        assert.equal(calls, 3);
      } finally {
        operation.dispose();
      }
      for (const error of [
        httpError(401),
        httpError(403),
        httpError(400),
        new Error("Invalid Google response"),
        new TranslationError("configuration"),
      ]) {
        let attempts = 0;
        const op = new TranslationOperation(async () => {});
        try {
          await assert.rejects(
            op.run(async () => {
              attempts++;
              throw error;
            }),
          );
          assert.equal(attempts, 1);
        } finally {
          op.dispose();
        }
      }
    },
  );
  await check(
    "Configuration change prevents retry before redispatch",
    async () => {
      let current = "old",
        attempts = 0;
      const operation = new TranslationOperation(async () => {
        if (current !== "old") throw new TranslationError("cancelled");
      });
      try {
        await assert.rejects(
          operation.run(async () => {
            attempts++;
            current = "new";
            throw httpError(503);
          }),
          (e: any) => e.code === "cancelled",
        );
        assert.equal(attempts, 1);
      } finally {
        operation.dispose();
      }
    },
  );
  await check(
    "Cancellation and total deadline abort transport without a second attempt",
    async () => {
      for (const cancel of [true, false]) {
        const controller = new AbortController();
        const operation = new TranslationOperation(
          async () => {},
          controller.signal,
          10,
        );
        let attempts = 0;
        try {
          const result = operation.run(
            () =>
              new Promise((_resolve, reject) => {
                attempts++;
                operation.signal.addEventListener(
                  "abort",
                  () => reject(operation.signal.reason),
                  { once: true },
                );
                if (cancel) controller.abort();
              }),
          );
          await assert.rejects(
            result,
            (e: any) => e.code === (cancel ? "cancelled" : "timeout"),
          );
          assert.equal(attempts, 1);
        } finally {
          operation.dispose();
        }
      }
    },
  );
  await check(
    "Page abort emits cancellation with bound nonsecret revision and ignores late work",
    async () => {
      const oldWindow = globalThis.window;
      const sent: any[] = [];
      (globalThis as any).window = {
        addEventListener() {},
        postMessage: (m: unknown) => sent.push(m),
      };
      try {
        const { translate } = await import("../src/page/bridge");
        const controller = new AbortController();
        const pending = translate(
          { text: "synthetic", target: "fr" },
          1000,
          controller.signal,
        );
        assert.equal(sent[0].kind, "TRANSLATE_REQUEST");
        assert.equal(typeof sent[0].revision, "string");
        assert(!JSON.stringify(sent).includes("apiKeys"));
        controller.abort();
        await assert.rejects(pending, (e: any) => e.code === "cancelled");
        assert.equal(sent[1].kind, "TRANSLATE_CANCEL");
        assert.equal(sent[1].id, sent[0].id);
        assert.equal(sent.length, 2);
      } finally {
        (globalThis as any).window = oldWindow;
      }
    },
  );
  return count;
}
