import assert from "node:assert/strict";
import {
  installManualIncomingPicker,
  PICK_MESSAGE_EVENT,
} from "../src/page/hooks/manual-incoming";
import { getConfig, getIncomingLang, setChatLang } from "../src/page/store";
import { IncomingAnnotations } from "../src/page/hooks/incoming-annotations";
import { TranslationError } from "../src/shared/errors";
import {
  DEFAULT_CONFIG,
  publicConfig,
  type TranslateRequest,
  type TranslateResult,
} from "../src/shared/types";

export async function runManualIncomingTests(): Promise<number> {
  let count = 0;
  const check = async (name: string, run: () => unknown) => {
    await run();
    count++;
    console.log("PASS", name);
  };
  const flush = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };
  const message = (key = "H") => ({
    id: {
      _serialized: `false_100@c.us_${key}`,
      remote: { _serialized: "100@c.us" },
      fromMe: false,
      id: key,
    },
    isNewMsg: false,
    type: "chat",
    body: "Only this synthetic selected text",
  });
  function fixture() {
    let active: string | null = "100@c.us",
      visible = true,
      target: string | null = "zh-CN";
    const reqs: {
      req: TranslateRequest;
      resolve: (r: TranslateResult) => void;
      reject: (e: unknown) => void;
    }[] = [];
    const notes: {
      text: string;
      source?: string;
      retry?: () => void;
      removed: boolean;
    }[] = [];
    const bubble = {};
    const controller = new IncomingAnnotations<object>({
      config: () => publicConfig(DEFAULT_CONFIG),
      enabledChat: () => !!target,
      incomingTarget: () => target,
      activeChat: () => active,
      bubble: () => (visible ? bubble : null),
      translate: (req) =>
        new Promise((resolve, reject) => reqs.push({ req, resolve, reject })),
      now: () => 0,
      show: (_b, text, _target, source, retry) => {
        const note = { text, source, retry, removed: false };
        notes.push(note);
        return {
          remove: () => {
            note.removed = true;
          },
          connected: () => !note.removed,
        };
      },
    });
    return {
      controller,
      reqs,
      notes,
      setActive: (x: string | null) => {
        active = x;
      },
      setVisible: (x: boolean) => {
        visible = x;
      },
      setTarget: (x: string | null) => {
        target = x;
      },
    };
  }
  await check(
    "Historical plaintext translates only through explicit selection without changing isNewMsg",
    async () => {
      const f = fixture(),
        m = message();
      f.controller.add(m);
      assert.equal(f.reqs.length, 0);
      assert(f.controller.manualSelect(m, m.id._serialized, "100@c.us"));
      assert.equal(f.reqs.length, 1);
      assert.equal(f.reqs[0].req.text, m.body);
      assert.equal(m.isNewMsg, false);
      f.reqs[0].resolve({
        translated: "选择的文本",
        target: "zh-CN",
        source: "en",
      });
      await flush();
      assert.equal(f.notes[0].source, "en");
      f.controller.stop();
    },
  );
  await check(
    "Manual selection rejects wrong identity, other chat, hidden bubble, ciphertext, media and outbound",
    () => {
      for (const bad of [
        "id",
        "remote",
        "active",
        "hidden",
        "ciphertext",
        "media",
        "fromMe",
        "disabled",
      ]) {
        const f = fixture(),
          m = message();
        if (bad === "remote") m.id.remote._serialized = "200@c.us";
        if (bad === "active") f.setActive("200@c.us");
        if (bad === "hidden") f.setVisible(false);
        if (bad === "ciphertext") m.type = "ciphertext";
        if (bad === "media") m.type = "image";
        if (bad === "fromMe") m.id.fromMe = true;
        if (bad === "disabled") f.setTarget(null);
        assert(
          !f.controller.manualSelect(
            m,
            bad === "id" ? "wrong" : m.id._serialized,
            "100@c.us",
          ),
        );
        assert.equal(f.reqs.length, 0);
        f.controller.stop();
      }
    },
  );
  await check(
    "Per-message failure exposes only safe text and retries only on manual action",
    async () => {
      const f = fixture(),
        m = message();
      f.controller.manualSelect(m, m.id._serialized, "100@c.us");
      f.reqs[0].reject(
        new Error("SECRET private body https://private.example"),
      );
      await flush();
      assert.equal(f.notes.length, 1);
      assert(!f.notes[0].text.includes("SECRET"));
      assert(f.notes[0].retry);
      f.controller.refresh();
      assert.equal(f.reqs.length, 1);
      f.notes[0].retry!();
      assert.equal(f.reqs.length, 2);
      f.notes[0].retry!();
      assert.equal(f.reqs.length, 2);
      f.reqs[1].resolve({ translated: "完成", source: "en", target: "zh-CN" });
      await flush();
      assert.equal(f.notes[1].source, "en");
      f.controller.stop();
    },
  );
  await check(
    "Retry revalidates text, identity, target, bubble and configuration revision",
    async () => {
      for (const change of [
        "body",
        "remote",
        "chat",
        "target",
        "hidden",
        "config",
        "stop",
      ]) {
        const f = fixture(),
          m = message();
        f.controller.manualSelect(m, m.id._serialized, "100@c.us");
        f.reqs[0].reject(new TranslationError("network"));
        await flush();
        const retry = f.notes[0].retry!;
        if (change === "body") m.body = "changed";
        if (change === "remote") m.id.remote._serialized = "200@c.us";
        if (change === "chat") f.setActive("200@c.us");
        if (change === "target") f.setTarget("fr");
        if (change === "hidden") f.setVisible(false);
        if (change === "config") f.controller.settingsChanged();
        if (change === "stop") f.controller.stop();
        retry();
        assert.equal(f.reqs.length, 1);
        f.controller.stop();
      }
    },
  );
  await check(
    "Manual picker resolves only the clicked full ID once and cancels its listeners",
    () => {
      const oldDocument = globalThis.document,
        oldElement = globalThis.Element,
        oldStyle = globalThis.getComputedStyle;
      const oldRequire = window.require,
        oldAdd = window.addEventListener,
        oldRemove = window.removeEventListener;
      const oldSet = globalThis.setTimeout,
        oldClear = globalThis.clearTimeout;
      const oldEnabled = getConfig().enabled,
        oldTarget = getIncomingLang("100@c.us");
      const handlers = new Map<string, any>();
      let reads = 0,
        selects = 0,
        cleared = 0;
      const msg = message();
      class FakeElement {
        isConnected = true;
        getAttribute() {
          return msg.id._serialized;
        }
        getClientRects() {
          return [{}];
        }
        closest(selector: string) {
          return selector === "#main [data-id]" ? this : null;
        }
      }
      const bubble = new FakeElement();
      window.require = (() => ({
        Chat: { findFirst: () => ({ id: { _serialized: "100@c.us" } }) },
      })) as any;
      getConfig().enabled = true;
      setChatLang("100@c.us", "zh-CN", "incoming");
      window.addEventListener = ((name: string, cb: any) =>
        handlers.set(name, cb)) as any;
      window.removeEventListener = ((name: string) =>
        handlers.delete(name)) as any;
      globalThis.Element = FakeElement as any;
      globalThis.getComputedStyle = (() => ({ visibility: "visible" })) as any;
      globalThis.document = {
        querySelector: () => ({ querySelectorAll: () => [bubble] }),
        addEventListener: (name: string, cb: any) => handlers.set(name, cb),
        removeEventListener: (name: string) => handlers.delete(name),
      } as any;
      globalThis.setTimeout = (() => 1) as any;
      globalThis.clearTimeout = (() => {
        cleared++;
      }) as any;
      let stop: (() => void) | undefined;
      try {
        stop = installManualIncomingPicker({
          getModel: (id) => {
            reads++;
            assert.equal(id, msg.id._serialized);
            return reads === 1 ? null : msg;
          },
          select: (model, id, chat) => {
            selects++;
            assert.equal(model, msg);
            assert.equal(id, msg.id._serialized);
            assert.equal(chat, "100@c.us");
            return true;
          },
        });
        handlers.get(PICK_MESSAGE_EVENT)();
        assert.equal(reads, 0);
        const click = handlers.get("click");
        click({ target: bubble, isTrusted: false });
        assert.equal(reads, 0);
        click({
          target: bubble,
          isTrusted: true,
          preventDefault() {},
          stopPropagation() {},
        });
        assert.equal(reads, 1);
        assert.equal(selects, 0);
        assert(handlers.has("click"), "failed selection must remain armed");
        click({
          target: bubble,
          isTrusted: true,
          preventDefault() {},
          stopPropagation() {},
        });
        assert.equal(reads, 2);
        assert.equal(selects, 1);
        assert(!handlers.has("click"));
        click({
          target: bubble,
          isTrusted: true,
          preventDefault() {},
          stopPropagation() {},
        });
        assert.equal(reads, 2);
        handlers.get(PICK_MESSAGE_EVENT)();
        stop();
        stop = undefined;
        assert(!handlers.has("click"));
        assert(!handlers.has(PICK_MESSAGE_EVENT));
        assert(cleared > 0);
      } finally {
        stop?.();
        globalThis.document = oldDocument;
        globalThis.Element = oldElement;
        globalThis.getComputedStyle = oldStyle;
        window.addEventListener = oldAdd;
        window.removeEventListener = oldRemove;
        globalThis.setTimeout = oldSet;
        globalThis.clearTimeout = oldClear;
        setChatLang("100@c.us", oldTarget, "incoming");
        getConfig().enabled = oldEnabled;
        window.require = oldRequire;
      }
    },
  );
  return count;
}
