import assert from "node:assert/strict";
import {
  IncomingAnnotations,
  findIncomingBubble,
  installIncomingAnnotations,
} from "../src/page/hooks/incoming-annotations";
import { DEFAULT_CONFIG, publicConfig } from "../src/shared/types";

export async function runIncomingTests(): Promise<number> {
  let count = 0;
  async function check(name: string, fn: () => unknown) {
    await fn();
    count++;
    console.log("PASS", name);
  }
  const flush = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };
  const message = (
    id = "false_100@c.us_A",
    chat = "100@c.us",
    body = "Hello",
  ) => ({
    id: {
      _serialized: id,
      id: id.split("_").at(-1)!,
      remote: { _serialized: chat },
      fromMe: false,
    },
    isNewMsg: true,
    type: "chat",
    body,
  });
  function fixture() {
    let active: string | null = "100@c.us";
    let now = 0;
    let config = publicConfig({
      ...DEFAULT_CONFIG,
      mode: "service",
      service: "google",
      nativeLang: "zh-CN",
    });
    const enabled = new Set(["100@c.us"]);
    const bubbles = new Map<string, object>();
    const requests: {
      req: any;
      resolve: (v: any) => void;
      reject: (e: any) => void;
    }[] = [];
    const notes: { bubble: object; text: string; removed: boolean }[] = [];
    const controller = new IncomingAnnotations<object>({
      config: () => config,
      enabledChat: (chat) => enabled.has(chat),
      activeChat: () => active,
      bubble: (id) => bubbles.get(id) ?? null,
      now: () => now,
      translate: (req) =>
        new Promise((resolve, reject) =>
          requests.push({ req, resolve, reject }),
        ),
      show: (bubble, text) => {
        const note = { bubble, text, removed: false };
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
      requests,
      notes,
      bubbles,
      enabled,
      setActive: (x: string | null) => {
        active = x;
      },
      setTime: (x: number) => {
        now = x;
      },
      setConfig: (x: any) => {
        config = { ...config, ...x };
      },
      result: (i = 0, text = "你好") =>
        requests[i].resolve({
          translated: text,
          source: "en",
          target: requests[i].req.target,
        }),
    };
  }
  await check(
    "Incoming requires enabled chat, new inbound plaintext and exact visible target",
    () => {
      const f = fixture();
      f.bubbles.set("false_100@c.us_A", {});
      const media = message("false_100@c.us_MEDIA");
      media.id.id = "MEDIA";
      f.bubbles.set(media.id._serialized, {});
      let mediaTypeReads = 0;
      Object.defineProperty(media, "type", {
        get: () => {
          mediaTypeReads++;
          return "image";
        },
      });
      for (const m of [
        null,
        {},
        { ...message(), isNewMsg: false },
        media,
        { ...message(), id: { ...message().id, fromMe: true } },
        message("false_200@c.us_B", "200@c.us"),
        message("not-visible"),
      ])
        f.controller.add(m as any);
      assert(
        mediaTypeReads > 0,
        "unique visible media reaches the type filter",
      );
      assert.equal(f.requests.length, 0);
      f.controller.stop();
    },
  );
  await check(
    "Incoming uses native language and does not mutate original models",
    async () => {
      const f = fixture();
      const msg = message();
      const original = JSON.stringify(msg);
      f.bubbles.set(msg.id._serialized, {});
      f.controller.add(msg);
      assert.equal(f.requests.length, 1);
      assert.equal(f.requests[0].req.target, "zh-CN");
      assert.equal(f.requests[0].req.source, "auto");
      f.result();
      await flush();
      assert.equal(f.notes.length, 1);
      assert.equal(JSON.stringify(msg), original);
      f.controller.stop();
      assert(f.notes[0].removed);
    },
  );
  await check(
    "Identical bodies with different complete message IDs stay separate; duplicates do not resend",
    async () => {
      const f = fixture();
      const a = message(),
        b = message("false_100@c.us_B");
      f.bubbles.set(a.id._serialized, {});
      f.bubbles.set(b.id._serialized, {});
      f.controller.add(a);
      f.controller.add(a);
      f.controller.add(b);
      assert.equal(f.requests.length, 2);
      f.result(0, "First");
      f.result(1, "Second");
      await flush();
      assert.equal(f.notes.length, 2);
      assert.notEqual(f.notes[0].bubble, f.notes[1].bubble);
      f.controller.stop();
    },
  );
  await check(
    "Ciphertext waits for decryption and removes its bounded listener",
    async () => {
      const f = fixture();
      let listener: (() => void) | undefined;
      let removes = 0;
      const msg = {
        ...message(),
        type: "ciphertext",
        on: (_e: string, cb: () => void) => {
          listener = cb;
        },
        off: () => {
          removes++;
          listener = undefined;
        },
      };
      f.bubbles.set(msg.id._serialized, {});
      f.controller.add(msg);
      assert.equal(f.requests.length, 0);
      assert(listener);
      msg.type = "chat";
      listener!();
      assert.equal(removes, 1);
      assert.equal(f.requests.length, 1);
      f.result();
      await flush();
      assert.equal(f.notes.length, 1);
      f.controller.stop();
      const g = fixture();
      const pending = { ...msg, type: "ciphertext" };
      g.controller.add(pending);
      g.setTime(30001);
      g.controller.refresh();
      assert.equal(removes, 2);
      assert.equal(g.requests.length, 0);
      g.controller.stop();
    },
  );
  await check(
    "Provider/native/target/enable changes invalidate pending and remove old notes without retransmission",
    async () => {
      for (const patch of [
        { service: "microsoft" },
        { nativeLang: "fr" },
        { enabled: false },
        { provider: "deepseek" },
      ]) {
        const f = fixture();
        const msg = message();
        f.bubbles.set(msg.id._serialized, {});
        f.controller.add(msg);
        f.setConfig(patch);
        f.controller.settingsChanged();
        f.result();
        await flush();
        assert.equal(f.notes.length, 0);
        f.controller.add(msg);
        assert.equal(f.requests.length, 1);
        f.controller.stop();
      }
      const f = fixture();
      const msg = message();
      f.bubbles.set(msg.id._serialized, {});
      f.controller.add(msg);
      f.result();
      await flush();
      f.controller.settingsChanged();
      assert(f.notes[0].removed);
      f.controller.stop();
    },
  );
  await check(
    "Chat switch, bubble removal and stopped controller never attach late results",
    async () => {
      for (const cause of ["chat", "bubble", "stop"]) {
        const f = fixture();
        const msg = message();
        f.bubbles.set(msg.id._serialized, {});
        f.controller.add(msg);
        if (cause === "chat") f.setActive("200@c.us");
        else if (cause === "bubble") f.bubbles.clear();
        else f.controller.stop();
        f.result();
        await flush();
        assert.equal(f.notes.length, 0);
        f.controller.stop();
      }
    },
  );
  await check(
    "Changed body/remote identity, expired entry and failed translation cannot show a stale note",
    async () => {
      for (const cause of ["body", "remote", "expiry", "failure"]) {
        const f = fixture();
        const msg = message();
        f.bubbles.set(msg.id._serialized, {});
        f.controller.add(msg);
        if (cause === "body") msg.body = "Edited";
        if (cause === "remote") msg.id.remote._serialized = "200@c.us";
        if (cause === "expiry") f.setTime(30001);
        if (cause === "failure") f.requests[0].reject(new Error("unavailable"));
        else f.result();
        await flush();
        assert.equal(f.notes.length, cause === "failure" ? 1 : 0);
        if (cause === "failure")
          assert(!f.notes[0].text.includes("unavailable"));
        f.controller.stop();
      }
    },
  );
  await check(
    "DOM matching requires complete ID, current chat, one visible connected element",
    () => {
      const savedDocument = (globalThis as any).document,
        savedStyle = (globalThis as any).getComputedStyle;
      window.require = (name: string) =>
        name === "WAWebCollections"
          ? {
              Chat: {
                findFirst: () => ({
                  active: true,
                  id: { _serialized: "100@c.us" },
                }),
              },
            }
          : null;
      const element = (id: string, visible = true) => ({
        getAttribute: () => id,
        isConnected: true,
        getClientRects: () => (visible ? [{}] : []),
      });
      let items: any[] = [element("false_100@c.us_A")];
      const exact = items[0];
      (globalThis as any).document = {
        querySelector: () => ({ querySelectorAll: () => items }),
      };
      (globalThis as any).getComputedStyle = () => ({ visibility: "visible" });
      try {
        assert.equal(findIncomingBubble("false_100@c.us_A", "100@c.us"), exact);
        assert.equal(findIncomingBubble("A", "100@c.us"), null);
        assert.equal(findIncomingBubble("false_100@c.us_A", "200@c.us"), null);
        items = [exact, element("false_100@c.us_A")];
        assert.equal(findIncomingBubble("false_100@c.us_A", "100@c.us"), null);
        items = [element("false_100@c.us_A", false)];
        assert.equal(findIncomingBubble("false_100@c.us_A", "100@c.us"), null);
        items = [exact];
        (globalThis as any).getComputedStyle = () => ({ visibility: "hidden" });
        assert.equal(findIncomingBubble("false_100@c.us_A", "100@c.us"), null);
      } finally {
        (globalThis as any).document = savedDocument;
        (globalThis as any).getComputedStyle = savedStyle;
      }
    },
  );
  await check(
    "Incoming installation is idempotent and disconnect removes listeners",
    () => {
      const oldAdd = window.addEventListener,
        oldRemove = window.removeEventListener,
        oldDocument = (globalThis as any).document,
        oldObserver = (globalThis as any).MutationObserver;
      const oldSet = globalThis.setInterval,
        oldClear = globalThis.clearInterval;
      let adds = 0,
        removes = 0,
        disconnects = 0,
        clears = 0;
      let pagehide: (() => void) | undefined;
      window.require = (name: string) =>
        name === "WAWebCollections"
          ? {
              Msg: { on: () => adds++, off: () => removes++ },
              Chat: { findFirst: () => null },
            }
          : null;
      window.addEventListener = ((event: string, cb: any) => {
        if (event === "pagehide") pagehide = cb;
      }) as any;
      window.removeEventListener = (() => {}) as any;
      (globalThis as any).document = {
        body: {},
        addEventListener() {},
        removeEventListener() {},
      };
      (globalThis as any).MutationObserver = class {
        observe() {}
        disconnect() {
          disconnects++;
        }
      };
      (globalThis as any).setInterval = () => 1;
      (globalThis as any).clearInterval = () => clears++;
      try {
        assert(installIncomingAnnotations());
        assert(installIncomingAnnotations());
        assert.equal(adds, 1);
        assert(pagehide);
        pagehide!();
        assert.equal(removes, 1);
        assert.equal(disconnects, 2); // incoming notes and hover-action observer
        assert.equal(clears, 1);
      } finally {
        window.addEventListener = oldAdd;
        window.removeEventListener = oldRemove;
        (globalThis as any).document = oldDocument;
        (globalThis as any).MutationObserver = oldObserver;
        globalThis.setInterval = oldSet;
        globalThis.clearInterval = oldClear;
      }
    },
  );

  await check(
    "Messages observed while disabled are never replayed on enable or reopen",
    () => {
      for (const mode of ["chat", "global"]) {
        const f = fixture();
        const msg = message();
        f.bubbles.set(msg.id._serialized, {});
        if (mode === "chat") f.enabled.clear();
        else f.setConfig({ enabled: false });
        f.controller.add(msg);
        assert.equal(f.requests.length, 0);
        f.enabled.add("100@c.us");
        f.setConfig({ enabled: true });
        f.controller.settingsChanged();
        f.controller.add(msg);
        f.controller.add({ ...msg });
        f.controller.refresh();
        assert.equal(f.requests.length, 0);
        f.controller.stop();
      }
      const f = fixture();
      const msg = message();
      f.bubbles.set(msg.id._serialized, {});
      f.controller.add(msg);
      f.enabled.clear();
      f.controller.settingsChanged();
      f.enabled.add("100@c.us");
      f.controller.settingsChanged();
      f.controller.add(msg);
      assert.equal(f.requests.length, 1);
      f.controller.stop();
    },
  );
  await check(
    "Ciphertext across provider change is discarded, not sent to the new service",
    () => {
      const f = fixture();
      let callback: (() => void) | undefined;
      let unlistened = 0;
      const msg = {
        ...message(),
        type: "ciphertext",
        on: (_e: string, cb: () => void) => {
          callback = cb;
        },
        off: () => {
          unlistened++;
        },
      };
      f.bubbles.set(msg.id._serialized, {});
      f.controller.add(msg);
      assert(callback);
      f.setConfig({ service: "microsoft" });
      f.controller.settingsChanged();
      assert.equal(unlistened, 1);
      msg.type = "chat";
      callback!();
      f.controller.add(msg);
      f.controller.refresh();
      assert.equal(f.requests.length, 0);
      f.controller.stop();
    },
  );
  return count;
}
