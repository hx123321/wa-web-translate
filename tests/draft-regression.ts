import assert from "node:assert/strict";
import { DraftSessions } from "../src/page/hooks/draft-state";
import { handleDraftShortcut } from "../src/page/hooks/composer";
import type { TranslateResult } from "../src/shared/types";
export async function runDraftTests(): Promise<number> {
  let count = 0;
  const check = async (name: string, fn: () => unknown) => {
    await fn();
    console.log("PASS", name);
    count++;
  };
  function fixture() {
    const calls: any[] = [];
    const manager = new DraftSessions(
      (req, signal) =>
        new Promise<TranslateResult>((resolve, reject) =>
          calls.push({ req, signal, resolve, reject }),
        ),
      () => {},
    );
    return { manager, calls };
  }
  await check("Typing, focus and unactivated send never translate", () => {
    const { manager, calls } = fixture();
    for (let i = 0; i < 100; i++) {
      manager.observe("a", "draft" + i, "fr", "config1");
      manager.focus("a", true);
    }
    assert.equal(calls.length, 0);
    assert.equal(manager.forSend("a", "draft99", "fr", "config1"), null);
    assert.equal(manager.read("a").visible, false);
  });
  await check(
    "Alt Enter prevents send propagation and repeated deliberate activation requests again",
    async () => {
      const { manager, calls } = fixture();
      let prevented = 0,
        stopped = 0,
        immediate = 0;
      const event = {
        key: "Enter",
        altKey: true,
        preventDefault: () => prevented++,
        stopPropagation: () => stopped++,
        stopImmediatePropagation: () => immediate++,
      } as any;
      const pending: Promise<void>[] = [];
      const activate = () => {
        pending.push(manager.activate("a", "Hello", "fr", "c1", true));
      };
      assert(handleDraftShortcut(event, activate));
      assert.equal(calls.length, 1);
      calls[0].resolve({ translated: "Bonjour", source: "en", target: "fr" });
      await pending[0];
      assert(handleDraftShortcut(event, activate));
      assert.equal(calls.length, 2);
      calls[1].resolve({ translated: "Salut", source: "en", target: "fr" });
      await pending[1];
      assert.equal(
        manager.forSend("a", "Hello", "fr", "c1")?.translated,
        "Salut",
      );
      assert.deepEqual([prevented, stopped, immediate], [2, 2, 2]);
      assert(handleDraftShortcut({ ...event, repeat: true }, activate));
      assert.equal(calls.length, 2);
      assert(!handleDraftShortcut({ ...event, altKey: false }, activate));
      assert.equal(calls.length, 2);
    },
  );
  await check(
    "Edited activated draft blocks stale send without requests; close restores original send",
    async () => {
      const { manager, calls } = fixture();
      const pending = manager.activate("a", "Hello", "fr", "c1", true);
      calls[0].resolve({ translated: "Bonjour", source: "en", target: "fr" });
      await pending;
      manager.observe("a", "Edited", "fr", "c1");
      assert.equal(calls.length, 1);
      assert.match(manager.read("a").error!, /变化/);
      assert.equal(manager.read("a").previewSource, "Hello");
      assert.equal(manager.read("a").previewTranslation, "Bonjour");
      assert.throws(() => manager.forSend("a", "Edited", "fr", "c1"));
      manager.close("a");
      assert.equal(manager.forSend("a", "Edited", "fr", "c1"), null);
      assert.equal(calls.length, 1);
    },
  );
  await check(
    "Blur hides and refocus restores preview without refetch; chats and windows stay isolated",
    async () => {
      const { manager, calls } = fixture();
      const pending = manager.activate("a", "Hello", "fr", "c1", true);
      calls[0].resolve({ translated: "Bonjour", source: "en", target: "fr" });
      await pending;
      manager.focus("a", false);
      assert.equal(manager.read("a").visible, false);
      manager.observe("b", "Hello", "fr", "c1");
      manager.focus("b", true);
      assert.equal(manager.read("b").visible, false);
      manager.focus("a", true);
      assert.equal(manager.read("a").translation, "Bonjour");
      assert(manager.read("a").visible);
      assert.equal(calls.length, 1);
      const other = fixture();
      other.manager.observe("a", "Hello", "fr", "c1");
      assert.equal(other.manager.forSend("a", "Hello", "fr", "c1"), null);
    },
  );
  await check(
    "Close, edits and provider changes abort pending draft and reject late responses",
    async () => {
      const { manager, calls } = fixture();
      const first = manager.activate("a", "One", "fr", "c1", true);
      manager.observe("a", "Two", "de", "c2");
      assert(calls[0].signal.aborted);
      calls[0].resolve({ translated: "Old", source: "en", target: "fr" });
      await first;
      assert.equal(manager.read("a").translation, "");
      assert.throws(() => manager.forSend("a", "Two", "de", "c2"));
      const second = manager.activate("a", "Two", "de", "c2", true);
      manager.close("a");
      assert(calls[1].signal.aborted);
      calls[1].resolve({ translated: "Late", source: "en", target: "de" });
      await second;
      assert.equal(manager.read("a").translation, "");
      assert.equal(manager.forSend("a", "Two", "de", "c2"), null);
    },
  );
  await check(
    "Failed active draft requires manual retry and new empty draft is unactivated",
    async () => {
      const { manager, calls } = fixture();
      const first = manager.activate("a", "Hello", "fr", "c1", true);
      calls[0].reject(new Error("Failed to fetch"));
      await first;
      assert.equal(calls.length, 1);
      assert.throws(() => manager.forSend("a", "Hello", "fr", "c1"));
      const second = manager.activate("a", "Hello", "fr", "c1", true);
      calls[1].resolve({ translated: "Bonjour", source: "en", target: "fr" });
      await second;
      assert.equal(calls.length, 2);
      manager.observe("a", "", "fr", "c1");
      assert.equal(manager.read("a").activated, false);
    },
  );
  await check(
    "Unrelated chat target changes keep another ready draft intact",
    async () => {
      const { manager, calls } = fixture();
      const pending = manager.activate("a", "Hello", "fr", "c1", true);
      calls[0].resolve({ translated: "Bonjour", source: "en", target: "fr" });
      await pending;
      manager.observe("b", "Other", "de", "c1");
      manager.updateTargets((chat) => (chat === "a" ? "fr" : "ja"), "c1");
      assert.equal(
        manager.forSend("a", "Hello", "fr", "c1")?.translated,
        "Bonjour",
      );
      assert.equal(calls.length, 1);
    },
  );
  await check(
    "More than 30 chats never evict an activated stale send gate",
    async () => {
      const { manager, calls } = fixture();
      for (let i = 0; i < 40; i++) {
        const pending = manager.activate(
          "active" + i,
          "Hello",
          "fr",
          "c1",
          true,
        );
        calls[i].resolve({ translated: "Bonjour", source: "en", target: "fr" });
        await pending;
      }
      for (let i = 0; i < 40; i++)
        manager.observe("inactive" + i, "Other", "fr", "c1");
      manager.observe("active0", "Edited", "fr", "c1");
      assert(manager.read("active0").activated);
      assert.throws(() => manager.forSend("active0", "Edited", "fr", "c1"));
      assert.equal(
        manager.forSend("active39", "Hello", "fr", "c1")?.translated,
        "Bonjour",
      );
      assert.equal(calls.length, 40);
      manager.close("active0");
      assert.equal(manager.forSend("active0", "Edited", "fr", "c1"), null);
    },
  );
  await check(
    "Preview renders activated snapshot and white close title row without live draft substitution",
    async () => {
      const { manager, calls } = fixture();
      const pending = manager.activate(
        "a",
        "Original snapshot",
        "fr",
        "c1",
        true,
      );
      calls[0].resolve({
        translated: "Translation snapshot",
        source: "en",
        target: "fr",
      });
      await pending;
      manager.observe("a", "New unsent edit", "fr", "c1");
      const { renderToStaticMarkup } = await import("react-dom/server.browser");
      const { createElement } = await import("react");
      const { DraftPreviewView } = await import("../src/page/ui/DraftPreview");
      const html = renderToStaticMarkup(
        createElement(DraftPreviewView, { state: manager.read("a") }),
      );
      for (const value of [
        "Original snapshot",
        "Translation snapshot",
        "原文：",
        "译文：",
        ">关闭</button>",
        "wa-translate-draft-heading",
      ])
        assert(html.includes(value));
      assert(!html.includes("New unsent edit"));
      assert.equal(calls.length, 1);
    },
  );
  await check(
    "Editing model connection never carries a built-in or previously approved custom key",
    async () => {
      const { editableConnection } = await import(
        "../src/options/connection-settings"
      );
      const { DEFAULT_CONFIG } = await import("../src/shared/types");
      const config = {
        ...DEFAULT_CONFIG,
        provider: "deepseek" as const,
        apiKeys: { deepseek: "SECRET_SENTINEL", custom: "OLD_KEY" },
      };
      const patch = editableConnection(config);
      assert.equal(patch.provider, "custom");
      assert.equal(patch.customBaseUrl, "https://api.deepseek.com");
      assert.equal(patch.model?.custom, config.model.deepseek);
      assert.deepEqual(patch.apiKeys, { custom: "" });
      assert.equal(patch.customCredential, null);
      assert(!JSON.stringify(patch).includes("SECRET_SENTINEL"));
      assert(!JSON.stringify(patch).includes("OLD_KEY"));
    },
  );
  return count;
}
