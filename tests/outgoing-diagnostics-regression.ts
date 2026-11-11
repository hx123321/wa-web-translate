import assert from "node:assert/strict";
import { DraftSessions } from "../src/page/hooks/draft-state";
import { installSendHook } from "../src/page/hooks/send";
import {
  clearOutgoingDiagnostics,
  getOutgoingDiagnostics,
  getOutgoingDiagnosticLabel,
  outgoingFailureStage,
  recordOutgoingDiagnostic,
} from "../src/page/outgoing-diagnostics";
import {
  clearTranslationDiagnostics,
  exportTranslationDiagnostics,
  recordIncomingDiagnostic,
} from "../src/page/diagnostics";
import { TranslationError } from "../src/shared/errors";
import type { TranslateResult } from "../src/shared/types";

export async function runOutgoingDiagnosticsTests(): Promise<number> {
  let count = 0;
  const check = async (name: string, fn: () => unknown) => {
    await fn();
    count++;
    console.log("PASS", name);
  };
  const stages = () => getOutgoingDiagnostics().map((r) => r.stage);
  const secret = "PRIVATE_BODY_CONTACT_ID_KEY_https://private.example";
  await check(
    "Outgoing diagnostics keep only bounded enum/time/count snapshots and safe export",
    async () => {
      clearTranslationDiagnostics();
      recordOutgoingDiagnostic(secret as any);
      assert.equal(getOutgoingDiagnostics().length, 0);
      for (let i = 0; i < 100; i++)
        recordOutgoingDiagnostic("activated", i + 1);
      const snapshot = getOutgoingDiagnostics();
      assert.equal(snapshot.length, 80);
      assert.equal(snapshot[0].count, 21);
      snapshot[0].stage = secret as any;
      recordOutgoingDiagnostic("failed_unknown", secret as any);
      for (const row of getOutgoingDiagnostics()) {
        assert.deepEqual(Object.keys(row).sort(), ["count", "stage", "time"]);
        assert(Number.isFinite(row.time));
        assert(Number.isFinite(row.count));
      }
      recordIncomingDiagnostic("id_missing");
      const text = exportTranslationDiagnostics();
      assert(text.includes("[接收]"));
      assert(text.includes("[发送]"));
      assert(!text.includes(secret));
      assert(!text.includes("private.example"));
      assert.equal(getOutgoingDiagnosticLabel(secret as any), "未知阶段");
      clearTranslationDiagnostics();
      assert.equal(getOutgoingDiagnostics().length, 0);
      await Promise.resolve();
    },
  );
  await check(
    "Draft logs activation, eligibility, request, response and preview without private values",
    async () => {
      clearOutgoingDiagnostics();
      const session = new DraftSessions(
        async () => ({ translated: secret, source: "en", target: "fr" }),
        () => {},
        recordOutgoingDiagnostic,
      );
      await session.activate(secret, secret, "fr", secret, true);
      assert.deepEqual(stages(), [
        "activated",
        "eligible",
        "request_started",
        "response_received",
        "preview_ready",
      ]);
      session.focus(secret, false);
      session.focus(secret, true);
      assert(stages().includes("preview_hidden"));
      assert(stages().includes("preview_shown"));
      assert(!JSON.stringify(getOutgoingDiagnostics()).includes(secret));
      session.close(secret);
      assert(stages().includes("closed"));
      session.dispose();
    },
  );
  await check(
    "Draft eligibility failures never claim requests; safe service failure stages are controlled",
    async () => {
      for (const [enabled, target, body, expected] of [
        [false, "fr", secret, "rejected_disabled"],
        [true, null, secret, "rejected_target"],
        [true, "fr", "", "rejected_body"],
      ] as const) {
        clearOutgoingDiagnostics();
        const session = new DraftSessions(
          async () => {
            throw new Error("Must not request");
          },
          () => {},
          recordOutgoingDiagnostic,
        );
        await session.activate(secret, body, target, secret, enabled);
        assert(stages().includes(expected));
        assert(!stages().includes("request_started"));
        session.dispose();
      }
      clearOutgoingDiagnostics();
      const session = new DraftSessions(
        async () => {
          throw new Error(secret);
        },
        () => {},
        recordOutgoingDiagnostic,
      );
      await session.activate(secret, secret, "fr", secret, true);
      assert(stages().includes("failed_unknown"));
      assert(!exportTranslationDiagnostics().includes(secret));
      assert.equal(
        outgoingFailureStage(new TranslationError("network")),
        "failed_network",
      );
      assert.equal(
        outgoingFailureStage(new TranslationError("cancelled")),
        "failed_cancelled",
      );
      session.dispose();
    },
  );
  await check(
    "Cancellation and late responses log no resend or fabricated automatic retry",
    async () => {
      clearOutgoingDiagnostics();
      let calls = 0;
      let resolve!: (result: TranslateResult) => void;
      const session = new DraftSessions(
        () => {
          calls++;
          return new Promise((r) => {
            resolve = r;
          });
        },
        () => {},
        recordOutgoingDiagnostic,
      );
      const request = session.activate(secret, secret, "fr", secret, true);
      session.invalidate();
      resolve({ translated: secret, source: "en", target: "fr" });
      await request;
      assert(stages().includes("cancelled"));
      assert(stages().includes("invalidated"));
      assert(stages().includes("stale_discarded"));
      assert.equal(calls, 1);
      assert(!stages().some((stage) => stage.includes("auto_retry")));
      session.dispose();
    },
  );
  await check(
    "WhatsApp hook logs interface success or failure exactly once without retrying",
    async () => {
      const originalRequire = window.require;
      try {
        for (const fail of [false, true]) {
          clearOutgoingDiagnostics();
          let calls = 0;
          const mod = {
            sendTextMsgToChat: async (..._args: any[]) => {
              calls++;
              if (fail) throw new Error(secret);
              return "synthetic-result";
            },
          };
          window.require = ((name: string) =>
            name === "WAWebSendTextMsgChatAction" ? mod : null) as any;
          installSendHook();
          const request = mod.sendTextMsgToChat(
            { id: { _serialized: "888888@c.us" } },
            secret,
          );
          if (fail) await assert.rejects(request);
          else assert.equal(await request, "synthetic-result");
          assert.equal(calls, 1);
          assert(stages().includes("send_triggered"));
          assert(stages().includes("wa_send_started"));
          assert.equal(
            stages().filter(
              (s) => s === (fail ? "wa_send_failed" : "wa_send_resolved"),
            ).length,
            1,
          );
          assert(!exportTranslationDiagnostics().includes(secret));
        }
      } finally {
        window.require = originalRequire;
      }
    },
  );
  return count;
}
