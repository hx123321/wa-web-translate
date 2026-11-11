import { TranslationError } from "../src/shared/errors";
import assert from "node:assert/strict";
import {
  IncomingAnnotations,
  incomingBubbleReason,
  type BubbleFailure,
} from "../src/page/hooks/incoming-annotations";
import {
  clearIncomingDiagnostics,
  getIncomingDiagnosticLabel,
  getIncomingDiagnostics,
  recordIncomingDiagnostic,
  type IncomingDiagnosticStage,
} from "../src/page/diagnostics";
import {
  DEFAULT_CONFIG,
  publicConfig,
  type TranslateResult,
} from "../src/shared/types";

export async function runIncomingDiagnosticsTests(): Promise<number> {
  let count = 0;
  const check = async (name: string, fn: () => unknown) => {
    await fn();
    count++;
    console.log("PASS", name);
  };
  await check(
    "Incoming diagnostics are bounded, enum-only, copied and content-free",
    async () => {
      clearIncomingDiagnostics();
      recordIncomingDiagnostic("https://secret.example/CONTACT_BODY_ID" as any);
      assert.equal(getIncomingDiagnostics().length, 0);
      for (let i = 0; i < 100; i++) recordIncomingDiagnostic("queued", i + 1);
      const entries = getIncomingDiagnostics();
      assert.equal(entries.length, 80);
      assert.equal(entries[0].count, 21);
      for (const item of entries) {
        assert.deepEqual(Object.keys(item).sort(), ["count", "stage", "time"]);
        assert(Number.isFinite(item.time));
        assert(Number.isFinite(item.count));
      }
      entries[0].stage = "CONTACT_BODY_ID" as any;
      assert(
        !JSON.stringify(getIncomingDiagnostics()).includes("CONTACT_BODY_ID"),
      );
      recordIncomingDiagnostic("failed", "CONTACT_BODY_ID" as any);
      assert.equal(getIncomingDiagnostics().at(-1)!.count, 1);
      clearIncomingDiagnostics();
      assert.equal(getIncomingDiagnostics().length, 0);
      await Promise.resolve();
    },
  );
  await check(
    "DOM diagnosis separates missing main, full ID, visibility, ambiguity and chat",
    () => {
      const old = globalThis.getComputedStyle;
      globalThis.getComputedStyle = (() => ({ visibility: "visible" })) as any;
      const el = (visible: boolean) =>
        ({
          isConnected: true,
          getClientRects: () => (visible ? [{}] : []),
        }) as unknown as HTMLElement;
      const index = new Map<string, HTMLElement[]>();
      try {
        assert.equal(
          incomingBubbleReason(false, true, index, "SECRET_ID"),
          "main_missing",
        );
        assert.equal(
          incomingBubbleReason(true, false, index, "SECRET_ID"),
          "chat_mismatch",
        );
        assert.equal(
          incomingBubbleReason(true, true, index, "SECRET_ID"),
          "id_missing",
        );
        index.set("SECRET_ID", [el(false)]);
        assert.equal(
          incomingBubbleReason(true, true, index, "SECRET_ID"),
          "invisible",
        );
        index.set("SECRET_ID", [el(true), el(true)]);
        assert.equal(
          incomingBubbleReason(true, true, index, "SECRET_ID"),
          "ambiguous",
        );
        index.set("SECRET_ID", [el(true)]);
        assert.equal(
          incomingBubbleReason(true, true, index, "SECRET_ID"),
          null,
        );
      } finally {
        globalThis.getComputedStyle = old;
      }
    },
  );
  await check(
    "Incoming timeout diagnoses decrypt, bubble and in-flight request without resending",
    async () => {
      for (const mode of ["decrypt", "bubble", "request"] as const) {
        let time = 0,
          calls = 0;
        const stages: IncomingDiagnosticStage[] = [],
          statuses: string[] = [];
        let resolve: ((r: TranslateResult) => void) | undefined;
        const controller = new IncomingAnnotations<object>({
          config: () => publicConfig(DEFAULT_CONFIG),
          enabledChat: () => true,
          activeChat: () => "100@c.us",
          bubble: () => (mode === "request" ? {} : null),
          bubbleReason: () => "id_missing",
          now: () => time,
          diagnostic: (s) => stages.push(s),
          status: (s) => statuses.push(s),
          translate: () => {
            calls++;
            return new Promise((r) => {
              resolve = r;
            });
          },
          show: () => {
            throw new Error("Must not display late text");
          },
        });
        const msg = {
          id: {
            _serialized: "false_100@c.us_SECRET_ID",
            remote: { _serialized: "100@c.us" },
            id: "SECRET_ID",
            fromMe: false,
          },
          type: mode === "decrypt" ? "ciphertext" : "chat",
          isNewMsg: true,
          body: "SECRET_BODY",
          on() {},
          off() {},
        };
        controller.add(msg);
        const before = stages.length;
        for (let i = 0; i < 20; i++) controller.refresh();
        assert.equal(
          stages.length,
          before,
          "unchanged refresh does not emit diagnostics",
        );
        time = 30001;
        controller.refresh();
        const expected =
          mode === "decrypt"
            ? "timeout_decrypt"
            : mode === "bubble"
              ? "timeout_bubble"
              : "timeout_request";
        assert(stages.includes(expected));
        assert(statuses.includes(expected));
        resolve?.({
          translated: "LATE_SECRET_BODY",
          source: "en",
          target: "en",
        });
        await Promise.resolve();
        await Promise.resolve();
        controller.refresh();
        assert.equal(calls, mode === "request" ? 1 : 0);
        assert(!JSON.stringify(stages).includes("SECRET"));
        controller.stop();
      }
    },
  );
  await check(
    "Every bubble diagnostic is a fixed category and never initiates a request",
    () => {
      for (const reason of [
        "main_missing",
        "id_missing",
        "ambiguous",
        "invisible",
        "chat_mismatch",
      ] as BubbleFailure[]) {
        const stages: IncomingDiagnosticStage[] = [];
        const controller = new IncomingAnnotations<object>({
          config: () => publicConfig(DEFAULT_CONFIG),
          enabledChat: () => true,
          activeChat: () => "100@c.us",
          bubble: () => null,
          bubbleReason: () => reason,
          now: () => 0,
          diagnostic: (s) => stages.push(s),
          translate: () => {
            throw new Error("No translation without unique visible full ID");
          },
          show: () => {
            throw new Error("No display");
          },
        });
        controller.add({
          id: {
            _serialized: "false_100@c.us_PRIVATE",
            id: "PRIVATE",
            remote: { _serialized: "100@c.us" },
            fromMe: false,
          },
          isNewMsg: true,
          type: "chat",
          body: "PRIVATE_BODY",
        });
        assert(stages.includes(reason));
        controller.stop();
      }
    },
  );
  await check(
    "Incoming rejection stages distinguish identity, direction, consent, newness, type and body",
    () => {
      for (const reason of [
        "rejected_identity",
        "rejected_outgoing",
        "rejected_disabled",
        "rejected_not_new",
        "rejected_type",
        "rejected_body",
      ] as IncomingDiagnosticStage[]) {
        const stages: IncomingDiagnosticStage[] = [];
        const msg: any = {
          id: {
            _serialized: "false_100@c.us_PRIVATE",
            id: "PRIVATE",
            remote: { _serialized: "100@c.us" },
            fromMe: false,
          },
          isNewMsg: true,
          type: "chat",
          body: "PRIVATE_BODY",
        };
        if (reason === "rejected_identity")
          msg.id.remote = { unexpected: "PRIVATE_CONTACT" };
        if (reason === "rejected_outgoing") msg.id.fromMe = true;
        if (reason === "rejected_not_new") msg.isNewMsg = false;
        if (reason === "rejected_type") msg.type = "image";
        if (reason === "rejected_body") msg.body = "";
        const controller = new IncomingAnnotations<object>({
          config: () => publicConfig(DEFAULT_CONFIG),
          enabledChat: () => reason !== "rejected_disabled",
          activeChat: () => "100@c.us",
          bubble: () => null,
          now: () => 0,
          diagnostic: (stage) => stages.push(stage),
          translate: () => {
            throw new Error("Rejected messages must never reach service");
          },
          show: () => {
            throw new Error("Rejected message must never display");
          },
        });
        controller.add(msg);
        assert(stages.includes(reason));
        assert(!JSON.stringify(stages).includes("PRIVATE"));
        assert.notEqual(getIncomingDiagnosticLabel(reason), "未知阶段");
        controller.stop();
      }
      assert.equal(
        getIncomingDiagnosticLabel("PRIVATE_CONTACT" as any),
        "未知阶段",
      );
    },
  );
  await check(
    "Diagnostic UI notifications coalesce and clearing adds no diagnostic entry",
    async () => {
      clearIncomingDiagnostics();
      await Promise.resolve();
      let notifications = 0;
      const oldDispatch = window.dispatchEvent;
      window.dispatchEvent = ((event: Event) => {
        if (event.type === "wa-translate:incoming-status") notifications++;
        return true;
      }) as any;
      try {
        for (let i = 0; i < 50; i++) recordIncomingDiagnostic("queued");
        await Promise.resolve();
        assert.equal(notifications, 1);
        clearIncomingDiagnostics();
        await Promise.resolve();
        assert.equal(notifications, 2);
        assert.equal(getIncomingDiagnostics().length, 0);
        clearIncomingDiagnostics();
        await Promise.resolve();
        assert.equal(notifications, 2);
      } finally {
        window.dispatchEvent = oldDispatch;
      }
    },
  );
  await check(
    "Service failure diagnostics keep safe error enums without repeat-on-refresh",
    async () => {
      for (const code of [
        "network",
        "timeout",
        "http",
        "authorization",
      ] as const) {
        const stages: IncomingDiagnosticStage[] = [];
        const controller = new IncomingAnnotations<object>({
          config: () => publicConfig(DEFAULT_CONFIG),
          enabledChat: () => true,
          activeChat: () => "100@c.us",
          bubble: () => ({}),
          now: () => 0,
          diagnostic: (stage) => stages.push(stage),
          translate: async () => {
            throw new TranslationError(code);
          },
          show: () => ({ remove() {}, connected: () => true }),
        });
        controller.add({
          id: {
            _serialized: "false_100@c.us_PRIVATE",
            id: "PRIVATE",
            remote: { _serialized: "100@c.us" },
            fromMe: false,
          },
          isNewMsg: true,
          type: "chat",
          body: "PRIVATE_BODY",
        });
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        assert(stages.includes(`failed_${code}`));
        const length = stages.length;
        for (let i = 0; i < 10; i++) controller.refresh();
        assert.equal(stages.length, length);
        assert(!JSON.stringify(stages).includes("PRIVATE"));
        controller.stop();
      }
    },
  );
  return count;
}
