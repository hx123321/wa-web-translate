import assert from "node:assert/strict";
import {
  IncomingAnnotations,
  incomingIdentity,
  visibleIncomingBubble,
  incomingBubbleReason,
  findIncomingBubble,
} from "../src/page/hooks/incoming-annotations";
import { resolveManualIncomingModel } from "../src/page/hooks/manual-incoming";
import { DEFAULT_CONFIG, publicConfig } from "../src/shared/types";

export async function runIncomingRawIdTests(): Promise<number> {
  let count = 0;
  const check = async (name: string, run: () => unknown) => {
    await run();
    count++;
    console.log("PASS", name);
  };
  const msg = (
    raw = "ABC",
    chat = "100@c.us",
    full = `false_${chat}_${raw}`,
  ) => ({
    id: {
      _serialized: full,
      id: raw,
      remote: { _serialized: chat },
      fromMe: false,
    },
    isNewMsg: true,
    type: "chat",
    body: "SYNTHETIC_ONLY",
  });
  const element = () =>
    ({
      isConnected: true,
      getClientRects: () => [{}],
    }) as unknown as HTMLElement;
  await check(
    "Raw DOM projection is refused without rendered identity; full serialization works",
    () => {
      const oldStyle = globalThis.getComputedStyle;
      globalThis.getComputedStyle = (() => ({ visibility: "visible" })) as any;
      try {
        const bubble = element(),
          index = new Map([["ABC", [bubble]]]);
        assert.equal(
          visibleIncomingBubble(index, "false_100@c.us_ABC", "ABC"),
          null,
        );
        assert.equal(visibleIncomingBubble(index, "false_100@c.us_ABC"), null);
        assert.equal(
          visibleIncomingBubble(index, "false_100@c.us_ABC", "AB"),
          null,
        );
        assert.equal(
          incomingBubbleReason(true, true, index, "false_100@c.us_ABC", "ABC"),
          "render_unverified",
        );
        index.clear();
        index.set("false_100@c.us_ABC", [bubble]);
        assert.equal(
          visibleIncomingBubble(index, "false_100@c.us_ABC", "ABC"),
          bubble,
        );
        index.set("false_100@c.us_ABC", [bubble, element()]);
        assert.equal(
          visibleIncomingBubble(index, "false_100@c.us_ABC", "ABC"),
          null,
        );
        assert.equal(
          incomingBubbleReason(true, true, index, "false_100@c.us_ABC", "ABC"),
          "ambiguous",
        );
      } finally {
        globalThis.getComputedStyle = oldStyle;
      }
    },
  );
  await check(
    "Virtualized, duplicate, hidden or wrong-chat raw bubbles never bind",
    () => {
      const oldStyle = globalThis.getComputedStyle,
        oldDoc = globalThis.document,
        oldRequire = window.require;
      const bubble = element();
      let items = [bubble];
      (bubble as any).getAttribute = () => "ABC";
      window.require = (() => ({
        Chat: { findFirst: () => ({ id: { _serialized: "100@lid" } }) },
      })) as any;
      globalThis.document = {
        querySelector: () => ({ querySelectorAll: () => items }),
      } as any;
      globalThis.getComputedStyle = (() => ({ visibility: "visible" })) as any;
      try {
        assert.equal(
          findIncomingBubble("false_100@lid_ABC", "100@lid", "ABC"),
          null,
        );
        assert.equal(
          findIncomingBubble("false_200@lid_ABC", "200@lid", "ABC"),
          null,
        );
        (bubble as any).isConnected = false;
        assert.equal(
          findIncomingBubble("false_100@lid_ABC", "100@lid", "ABC"),
          null,
        );
        (bubble as any).isConnected = true;
        (bubble as any).getAttribute = () => "OTHER";
        assert.equal(
          findIncomingBubble("false_100@lid_ABC", "100@lid", "ABC"),
          null,
        );
        (bubble as any).getAttribute = () => "ABC";
        const duplicate = element();
        (duplicate as any).getAttribute = () => "ABC";
        items = [bubble, duplicate];
        assert.equal(
          findIncomingBubble("false_100@lid_ABC", "100@lid", "ABC"),
          null,
        );
      } finally {
        globalThis.document = oldDoc;
        globalThis.getComputedStyle = oldStyle;
        window.require = oldRequire;
      }
    },
  );
  await check(
    "Automatic raw lookup uses only new-event model identities and preserves cross-chat binding",
    () => {
      let calls = 0;
      const lookups: string[] = [];
      const controller = new IncomingAnnotations<object>({
        config: () => publicConfig(DEFAULT_CONFIG),
        enabledChat: () => true,
        activeChat: () => "100@c.us",
        now: () => 0,
        bubble: (full, chat, raw) => {
          lookups.push(`${full}|${chat}|${raw}`);
          return raw === "ABC" ? {} : null;
        },
        translate: () => {
          calls++;
          return new Promise(() => {});
        },
        show: () => {
          throw new Error("No result");
        },
      });
      const historical = msg("H");
      historical.isNewMsg = false;
      controller.add(historical);
      controller.add(msg("ABC", "200@c.us"));
      assert.equal(calls, 0);
      controller.add(msg());
      assert.equal(calls, 1);
      assert(lookups.every((value) => value.includes("100@c.us")));
      controller.stop();
    },
  );
  await check(
    "Conflicting complete identities with same raw ID stay blocked after one expires",
    () => {
      let calls = 0,
        visible = false,
        now = 0;
      const controller = new IncomingAnnotations<object>({
        config: () => publicConfig(DEFAULT_CONFIG),
        enabledChat: () => true,
        activeChat: () => "100@g.us",
        now: () => now,
        bubble: () => (visible ? {} : null),
        translate: () => {
          calls++;
          return new Promise(() => {});
        },
        show: () => {
          throw new Error("No ambiguous display");
        },
      });
      controller.add(msg("ABC", "100@g.us", "false_100@g.us_ABC_111@lid"));
      now = 10;
      controller.add(msg("ABC", "100@g.us", "false_100@g.us_ABC_222@lid"));
      visible = true;
      controller.refresh();
      assert.equal(calls, 0);
      now = 30001;
      controller.refresh();
      assert.equal(calls, 0);
      controller.stop();
    },
  );
  await check(
    "Manual raw lookup is refused; unrelated bodies are never read",
    () => {
      const oldRequire = window.require;
      let bodyReads = 0,
        lookups = 0;
      const wanted = msg("ABC", "100@lid", "false_100@lid_ABC_222@lid");
      wanted.isNewMsg = false;
      const other = msg("OTHER", "100@lid");
      Object.defineProperty(other, "body", {
        get: () => {
          bodyReads++;
          throw new Error("Unrelated body read");
        },
      });
      let models: any[] = [other, wanted];
      const active = {
        active: true,
        id: { _serialized: "100@lid" },
        msgs: { getModelsArray: () => models },
      };
      const collections = {
        Chat: { findFirst: () => active },
        Msg: {
          get: (id: string) => {
            lookups++;
            return id === wanted.id._serialized ? wanted : null;
          },
        },
      };
      window.require = (() => collections) as any;
      try {
        assert.equal(
          resolveManualIncomingModel("ABC", "100@lid", collections),
          null,
        );
        assert.equal(bodyReads, 0);
        assert.equal(lookups, 1);
        assert.equal(
          resolveManualIncomingModel(
            wanted.id._serialized,
            "100@lid",
            collections,
          ),
          wanted,
        );
        assert.equal(
          resolveManualIncomingModel("ABC", "200@lid", collections),
          null,
        );
        models = [wanted, msg("ABC", "100@lid", "false_100@lid_ABC_OTHER")];
        assert.equal(
          resolveManualIncomingModel("ABC", "100@lid", collections),
          null,
        );
        models = [
          wanted,
          {
            ...wanted,
            id: { ...wanted.id, fromMe: true, _serialized: "true_100@lid_ABC" },
          },
        ];
        assert.equal(
          resolveManualIncomingModel("ABC", "100@lid", collections),
          null,
        );
        models = Array.from({ length: 2001 }, () => other);
        assert.equal(
          resolveManualIncomingModel("ABC", "100@lid", collections),
          null,
        );
        models = [{ ...wanted, id: { ...wanted.id, fromMe: true } }];
        assert.equal(
          resolveManualIncomingModel("ABC", "100@lid", collections),
          null,
        );
        assert.equal(bodyReads, 0);
      } finally {
        window.require = oldRequire;
      }
    },
  );
  await check(
    "Manual raw selection is refused without faking historical newness",
    () => {
      let calls = 0;
      const controller = new IncomingAnnotations<object>({
        config: () => publicConfig(DEFAULT_CONFIG),
        enabledChat: () => true,
        activeChat: () => "100@c.us",
        now: () => 0,
        bubble: (id, chat, raw) =>
          id === "false_100@c.us_ABC" && chat === "100@c.us" && raw === "ABC"
            ? {}
            : null,
        translate: () => {
          calls++;
          return new Promise(() => {});
        },
        show: () => {
          throw new Error("No result");
        },
      });
      const historical = msg();
      historical.isNewMsg = false;
      assert.equal(
        controller.manualSelect(historical, "ABC", "100@c.us"),
        false,
      );
      assert.equal(calls, 0);
      assert.equal(historical.isNewMsg, false);
      assert.equal(incomingIdentity(historical)?.id, "false_100@c.us_ABC");
      controller.stop();
    },
  );
  await check(
    "New-event raw identity collisions across directions block automatic binding",
    () => {
      for (const outgoingFirst of [true, false]) {
        let calls = 0,
          visible = false;
        const controller = new IncomingAnnotations<object>({
          config: () => publicConfig(DEFAULT_CONFIG),
          enabledChat: () => true,
          activeChat: () => "100@c.us",
          now: () => 0,
          bubble: () => (visible ? {} : null),
          translate: () => {
            calls++;
            return new Promise(() => {});
          },
          show: () => {
            throw new Error("No collision display");
          },
        });
        const incoming = msg();
        const outgoing = msg("ABC", "100@c.us", "true_100@c.us_ABC");
        outgoing.id.fromMe = true;
        controller.add(outgoingFirst ? outgoing : incoming);
        controller.add(outgoingFirst ? incoming : outgoing);
        visible = true;
        controller.refresh();
        assert.equal(calls, 0);
        controller.stop();
      }
    },
  );
  return count;
}
