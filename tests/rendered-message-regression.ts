import assert from "node:assert/strict";
import { committedBubbleModel } from "../src/page/hooks/rendered-message";
import { resolveManualIncomingModel } from "../src/page/hooks/manual-incoming";
import { visibleIncomingBubble } from "../src/page/hooks/incoming-annotations";
export function runRenderedMessageTests(): number {
  let count = 0;
  const test = (name: string, fn: () => void) => {
    fn();
    count++;
    console.log("PASS", name);
  };
  const message = (chat = "100@c.us", fromMe = false) => ({
    __x_id: {
      $1: `${fromMe}_${chat}_ABC`,
      remote: { _serialized: chat },
      id: "ABC",
      fromMe,
    },
  });
  const fixture = (msg = message()) => {
    const node: any = {
      isConnected: true,
      getAttribute: () => "ABC",
      getClientRects: () => [{}],
    };
    const root: any = { stateNode: {} };
    root.stateNode.current = root;
    const parent: any = { return: root, memoizedProps: { msg } };
    root.child = parent;
    const host: any = { stateNode: node, return: parent };
    parent.child = host;
    node.__reactFiber$test = host;
    return { node, root, parent, host, msg };
  };
  test("Committed host and current alternate resolve identical model references", () => {
    const f = fixture();
    assert.equal(committedBubbleModel(f.node), f.msg);
    const stale: any = {
      stateNode: f.node,
      return: f.parent,
      alternate: f.host,
    };
    f.node.__reactFiber$test = stale;
    assert.equal(committedBubbleModel(f.node), f.msg);
    f.parent.child = stale;
    f.root.stateNode.current = {};
    assert.equal(committedBubbleModel(f.node), null);
  });
  test("Conflicting ancestors, cycles, bounds, dual current paths and getters reject", () => {
    let f = fixture();
    f.root.memoizedProps = { msg: message() };
    assert.equal(committedBubbleModel(f.node), null);
    f = fixture();
    f.root.return = f.parent;
    assert.equal(committedBubbleModel(f.node), null);
    f = fixture();
    f.host.alternate = fixture().host;
    f.host.alternate.stateNode = f.node;
    assert.equal(committedBubbleModel(f.node), null);
    f = fixture();
    Object.defineProperty(f.parent, "memoizedProps", {
      get() {
        throw Error("must not run");
      },
    });
    assert.equal(committedBubbleModel(f.node), null);
    f = fixture();
    let child = f.host;
    for (let i = 0; i < 260; i++) {
      const p: any = { child };
      child.return = p;
      child = p;
    }
    child.stateNode = { current: child };
    assert.equal(committedBubbleModel(f.node), null);
  });
  test("Raw bubble binds full identity/chat/direction and rejects stale DOM and reuse", () => {
    const old = globalThis.getComputedStyle;
    globalThis.getComputedStyle = (() => ({ visibility: "visible" })) as any;
    try {
      const f = fixture(),
        index = new Map([["ABC", [f.node]]]);
      assert.equal(
        visibleIncomingBubble(index, "false_100@c.us_ABC", "ABC", "100@c.us"),
        f.node,
      );
      assert.equal(
        visibleIncomingBubble(index, "false_200@c.us_ABC", "ABC", "200@c.us"),
        null,
      );
      f.parent.memoizedProps.msg = message("200@c.us");
      assert.equal(
        visibleIncomingBubble(index, "false_100@c.us_ABC", "ABC", "100@c.us"),
        null,
      );
      assert.equal(
        visibleIncomingBubble(index, "false_200@c.us_ABC", "ABC", "200@c.us"),
        f.node,
      );
      f.parent.memoizedProps.msg = message("200@c.us", true);
      assert.equal(
        visibleIncomingBubble(index, "false_200@c.us_ABC", "ABC", "200@c.us"),
        null,
      );
      f.parent.memoizedProps.msg = message();
      index.get("ABC")!.push(fixture().node);
      assert.equal(
        visibleIncomingBubble(index, "false_100@c.us_ABC", "ABC", "100@c.us"),
        null,
      );
    } finally {
      globalThis.getComputedStyle = old;
    }
  });
  test("Manual click rejects old-chat DOM and resolves only current rendered store object", () => {
    const oldRequire = window.require,
      oldDoc = globalThis.document,
      oldStyle = globalThis.getComputedStyle;
    const f = fixture();
    let chat = "200@c.us";
    const b = message(chat);
    let bodyReads = 0;
    Object.defineProperty(b, "body", {
      get() {
        bodyReads++;
        return "PRIVATE_SYNTHETIC";
      },
    });
    const collections = {
      Chat: { findFirst: () => ({ active: true, id: { _serialized: chat } }) },
      Msg: { get: (id: string) => (id === b.__x_id.$1 ? b : null) },
    };
    window.require = (() => collections) as any;
    f.node.getAttribute = () => "ABC";
    globalThis.document = {
      querySelector: () => ({ querySelectorAll: () => [f.node] }),
    } as any;
    globalThis.getComputedStyle = (() => ({ visibility: "visible" })) as any;
    try {
      assert.equal(resolveManualIncomingModel("ABC", chat, collections), null);
      assert.equal(bodyReads, 0);
      f.parent.memoizedProps.msg = b;
      assert.equal(resolveManualIncomingModel("ABC", chat, collections), b);
      assert.equal(bodyReads, 0);
      const get = collections.Msg.get;
      collections.Msg.get = (id: string) => {
        if (id === "ABC") throw new Error("Invalid raw key");
        return get(id);
      };
      assert.equal(resolveManualIncomingModel("ABC", chat, collections), b);
      assert.equal(bodyReads, 0);
      f.parent.memoizedProps.msg = message(chat); // equal key but different model must reject
      assert.equal(resolveManualIncomingModel("ABC", chat, collections), null);
      f.parent.memoizedProps.msg = b;
      f.parent.child = {};
      assert.equal(resolveManualIncomingModel("ABC", chat, collections), null);
      assert.equal(bodyReads, 0);
    } finally {
      window.require = oldRequire;
      globalThis.document = oldDoc;
      globalThis.getComputedStyle = oldStyle;
    }
  });
  return count;
}
