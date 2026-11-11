import assert from "node:assert/strict";
import { httpError, safeTranslationError } from "../src/shared/errors";
import { installCapabilities, isReady, waitTillReady } from "../src/page/wa";
export async function runErrorsReadinessTests(): Promise<number> {
  assert.equal(safeTranslationError(httpError(429)).code, "rate_limit");
  assert.equal(safeTranslationError(httpError(401)).code, "authorization");
  assert.equal(safeTranslationError(httpError(503)).status, 503);
  assert.match(safeTranslationError(httpError(503)).message, /503/);
  for (const secret of [
    "https://private.test/key-secret",
    "body secret",
    "token-secret",
  ])
    assert(
      !JSON.stringify(safeTranslationError(new Error(secret))).includes(secret),
    );
  assert.equal(
    safeTranslationError(new Error("Failed to fetch")).code,
    "network",
  );
  assert.equal(
    safeTranslationError(new DOMException("private-body", "TimeoutError")).code,
    "timeout",
  );
  assert.equal(
    safeTranslationError(new Error("Invalid Google response")).code,
    "response",
  );
  assert.equal(
    safeTranslationError(new Error("Configure a model.")).code,
    "configuration",
  );
  console.log(
    "PASS Safe Chinese errors preserve numeric status without arbitrary exception data",
  );
  const oldWindow = globalThis.window;
  const oldNow = Date.now,
    oldSet = globalThis.setTimeout,
    oldClear = globalThis.clearTimeout;
  let now = 0,
    scheduled: (() => void) | undefined,
    cleared = false;
  try {
    (globalThis as any).window = { require: () => ({}) };
    Date.now = () => now;
    (globalThis as any).setTimeout = (fn: () => void) => {
      scheduled = fn;
      return 1;
    };
    (globalThis as any).clearTimeout = () => {
      cleared = true;
      scheduled = undefined;
    };
    assert(isReady());
    assert.equal(await waitTillReady(10), true);
    let sendCalls = 0,
      incomingCalls = 0;
    const statuses: any[] = [];
    const stop = installCapabilities(
      {
        send: () => {
          sendCalls++;
          return true;
        },
        incoming: () => {
          incomingCalls++;
          return false;
        },
        status: (value) => statuses.push(value),
      },
      3000,
    );
    assert.equal(sendCalls, 1);
    assert.equal(statuses[0].send, true);
    now = 1500;
    scheduled!();
    assert.equal(sendCalls, 1);
    now = 3000;
    const last = scheduled!;
    scheduled = undefined;
    last();
    assert.equal(incomingCalls, 3);
    assert.equal(statuses.at(-1).waiting, false);
    assert.equal(scheduled, undefined);
    stop();
    assert(cleared);
    (globalThis as any).window = {};
    const ready = waitTillReady(10);
    now += 10;
    scheduled!();
    assert.equal(await ready, false);
  } finally {
    (globalThis as any).window = oldWindow;
    Date.now = oldNow;
    globalThis.setTimeout = oldSet;
    globalThis.clearTimeout = oldClear;
  }
  console.log(
    "PASS Debug-free readiness is bounded and hooks install independently once",
  );
  return 2;
}
