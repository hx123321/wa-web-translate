import assert from "node:assert/strict";
import {
  IncomingAnnotations,
  indexIncomingBubbles,
  visibleIncomingBubble,
} from "../src/page/hooks/incoming-annotations";
import {
  createDomScheduler,
  isOnlyOwnMutation,
} from "../src/page/dom-scheduler";
import {
  DEFAULT_CONFIG,
  publicConfig,
  type TranslateRequest,
  type TranslateResult,
} from "../src/shared/types";

export async function runIncomingPerformanceTests(): Promise<number> {
  let count = 0;
  const check = async (name: string, test: () => unknown) => {
    await test();
    count++;
    console.log("PASS", name);
  };
  await check(
    "Incoming DOM indexing queries once and only measures exact IDs",
    () => {
      let queries = 0,
        layouts = 0;
      const saved = globalThis.getComputedStyle;
      const element = (id: string) =>
        ({
          getAttribute: () => id,
          isConnected: true,
          getClientRects: () => {
            layouts++;
            return [{}];
          },
        }) as unknown as HTMLElement;
      const nodes = Array.from({ length: 1000 }, (_, i) =>
        element(`message-${i}`),
      );
      const main = {
        querySelectorAll: () => {
          queries++;
          return nodes;
        },
      } as unknown as ParentNode;
      globalThis.getComputedStyle = (() => ({ visibility: "visible" })) as any;
      try {
        const index = indexIncomingBubbles(main);
        for (let i = 0; i < 100; i++)
          assert.equal(visibleIncomingBubble(index, `message-${i}`), nodes[i]);
        assert.equal(queries, 1);
        assert.equal(layouts, 100);
        assert.equal(visibleIncomingBubble(index, "unknown"), null);
        assert.equal(layouts, 100);
        nodes.push(element("message-0"));
        assert.equal(
          visibleIncomingBubble(indexIncomingBubbles(main), "message-0"),
          null,
        );
      } finally {
        globalThis.getComputedStyle = saved;
      }
    },
  );
  await check("DOM scheduling coalesces bursts and cancels queued work", () => {
    const oldSet = globalThis.setTimeout,
      oldClear = globalThis.clearTimeout;
    const timers = new Map<number, () => void>();
    let scheduled = 0,
      ran = 0;
    globalThis.setTimeout = ((cb: () => void, delay: number) => {
      assert.equal(delay, 100);
      timers.set(++scheduled, cb);
      return scheduled;
    }) as any;
    globalThis.clearTimeout = ((id: number) => timers.delete(id)) as any;
    try {
      const scheduler = createDomScheduler(() => ran++);
      for (let i = 0; i < 1000; i++) scheduler.request();
      assert.equal(scheduled, 1);
      const first = timers.get(1)!;
      timers.delete(1);
      first();
      assert.equal(ran, 1);
      scheduler.request();
      assert.equal(scheduled, 2);
      const pending = timers.get(2)!;
      scheduler.cancel();
      pending();
      scheduler.request();
      assert.equal(timers.size, 0);
      assert.equal(ran, 1);
      assert.equal(scheduled, 2);
    } finally {
      globalThis.setTimeout = oldSet;
      globalThis.clearTimeout = oldClear;
    }
  });
  await check("Only extension annotation mutations are ignored", () => {
    const own = { nodeType: 1, closest: () => ({}) } as unknown as Node;
    const foreign = { nodeType: 1, closest: () => null } as unknown as Node;
    const record = (added: Node[], removed: Node[] = []) =>
      ({
        type: "childList",
        target: foreign,
        addedNodes: added,
        removedNodes: removed,
      }) as unknown as MutationRecord;
    assert(isOnlyOwnMutation(record([own])));
    assert(isOnlyOwnMutation(record([], [own])));
    assert(!isOnlyOwnMutation(record([own, foreign])));
    assert(!isOnlyOwnMutation(record([])));
  });
  await check(
    "Independent incoming target overrides native language and target changes never resend",
    async () => {
      let target: string | null = "de",
        prepares = 0,
        shown = 0;
      const config = publicConfig({ ...DEFAULT_CONFIG, nativeLang: "zh-CN" });
      const requests: TranslateRequest[] = [];
      const resolvers: ((value: TranslateResult) => void)[] = [];
      const controller = new IncomingAnnotations<object>({
        config: () => config,
        enabledChat: () => !!target,
        incomingTarget: () => target,
        activeChat: () => "100@c.us",
        prepareBubbles: () => {
          prepares++;
        },
        bubble: () => ({}),
        now: () => 0,
        translate: (req) => {
          requests.push(req);
          return new Promise((resolve) => resolvers.push(resolve));
        },
        show: () => {
          shown++;
          return { remove() {}, connected: () => true };
        },
      });
      const message = (id: string) => ({
        id: {
          _serialized: `false_100@c.us_${id}`,
          remote: { _serialized: "100@c.us" },
          id,
          fromMe: false,
        },
        isNewMsg: true,
        type: "chat",
        body: "Synthetic test text",
      });
      const a = message("A"),
        b = message("B");
      controller.add(a);
      controller.add(b);
      assert.equal(requests.length, 2);
      assert.equal(requests[0].target, "de");
      assert.equal(requests[0].source, "auto");
      prepares = 0;
      controller.refresh();
      assert.equal(prepares, 1);
      target = "fr";
      controller.settingsChanged();
      resolvers[0]({ translated: "Alt", source: "en", target: "de" });
      await Promise.resolve();
      await Promise.resolve();
      controller.add(a);
      controller.refresh();
      assert.equal(requests.length, 2);
      assert.equal(shown, 0);
      target = null;
      controller.settingsChanged();
      const disabled = message("C");
      controller.add(disabled);
      target = "it";
      controller.settingsChanged();
      controller.add(disabled);
      assert.equal(requests.length, 2);
      controller.add(message("D"));
      assert.equal(requests.length, 3);
      assert.equal(requests[2].target, "it");
      controller.stop();
    },
  );
  await check(
    "Incoming diagnostics expose only categories and failed requests never auto-retry",
    async () => {
      let now = 0,
        visible = false,
        requests = 0;
      const statuses: string[] = [];
      const controller = new IncomingAnnotations<object>({
        config: () => publicConfig(DEFAULT_CONFIG),
        enabledChat: () => true,
        incomingTarget: () => "zh-CN",
        activeChat: () => "100@c.us",
        now: () => now,
        bubble: () => (visible ? {} : null),
        translate: async () => {
          requests++;
          throw new Error("SYNTHETIC_PRIVATE_BODY");
        },
        status: (status) => statuses.push(status),
        show: () => ({ remove() {}, connected: () => true }),
      });
      const msg = (id: string) => ({
        id: {
          _serialized: `false_100@c.us_${id}`,
          id,
          remote: { _serialized: "100@c.us" },
          fromMe: false,
        },
        isNewMsg: true,
        type: "chat",
        body: "SYNTHETIC_PRIVATE_BODY",
      });
      controller.add(msg("WAIT"));
      assert.equal(statuses.at(-1), "id_missing");
      assert.equal(requests, 0);
      now = 30001;
      controller.refresh();
      assert.equal(statuses.at(-1), "timeout_bubble");
      visible = true;
      const failed = msg("FAIL");
      controller.add(failed);
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(statuses.at(-1), "failed");
      assert.equal(requests, 1);
      for (let i = 0; i < 10; i++) controller.refresh();
      controller.add(failed);
      assert.equal(requests, 1);
      assert(!JSON.stringify(statuses).includes("PRIVATE"));
      assert(!JSON.stringify(statuses).includes("100@"));
      controller.stop();
    },
  );
  return count;
}
