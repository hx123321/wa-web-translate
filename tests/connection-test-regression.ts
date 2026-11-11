import assert from "node:assert/strict";
import {
  testModelConnection,
  CONNECTION_TEST_TEXT,
} from "../src/background/connection-test";
import { DEFAULT_CONFIG } from "../src/shared/types";
import { TranslationError } from "../src/shared/errors";
export async function runConnectionTestChecks(): Promise<number> {
  const config = {
    ...DEFAULT_CONFIG,
    provider: "deepseek" as const,
    apiKeys: { deepseek: "SECRET" },
  };
  let calls = 0;
  const result = await testModelConnection(
    async () => config,
    async (c, args) => {
      calls++;
      assert.equal(c.apiKeys.deepseek, "SECRET");
      assert.equal(args.user, CONNECTION_TEST_TEXT);
      return "REMOTE_UNTRUSTED_OUTPUT";
    },
  );
  assert.equal(result.ok, true);
  assert.equal(calls, 1);
  assert(!JSON.stringify(result).includes("SECRET"));
  assert(!JSON.stringify(result).includes("REMOTE"));
  console.log(
    "PASS Connection test sends only fixed disclosed text once and omits model output and credentials",
  );
  const fail = await testModelConnection(
    async () => config,
    async () => {
      throw new Error("SECRET https://private.invalid arbitrary body");
    },
  );
  assert.equal(fail.ok, false);
  assert(!JSON.stringify(fail).includes("SECRET"));
  const http = await testModelConnection(
    async () => config,
    async () => {
      throw new TranslationError("authorization", 401);
    },
  );
  assert.equal(http.ok, false);
  if (!http.ok) {
    assert.equal(http.code, "authorization");
    assert.equal(http.status, 401);
  }
  console.log(
    "PASS Connection failures return safe enum and numeric HTTP status only",
  );
  let rejectedCalls = 0;
  await testModelConnection(
    async () => ({ ...config, apiKeys: {} }),
    async () => {
      rejectedCalls++;
      return "OK";
    },
  );
  assert.equal(rejectedCalls, 0);
  let reads = 0;
  const changed = await testModelConnection(
    async () => ({ ...config, revision: String(++reads) }),
    async () => "OK",
  );
  assert.equal(changed.ok, false);
  if (!changed.ok) assert.equal(changed.code, "cancelled");
  console.log(
    "PASS Unsaved or missing key cannot dispatch and changed settings invalidate test result",
  );
  return 3;
}
