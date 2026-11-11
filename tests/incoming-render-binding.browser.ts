import {
  IncomingAnnotations,
  findIncomingBubble,
  incomingBubbleReason,
  indexIncomingBubbles,
} from "../src/page/hooks/incoming-annotations";
import { resolveManualIncomingModel } from "../src/page/hooks/manual-incoming";
import { DEFAULT_CONFIG, publicConfig } from "../src/shared/types";
function assert(ok: unknown, label: string) {
  if (!ok) throw new Error(label);
}
try {
  let active = "100@c.us",
    requests = 0,
    reads = 0;
  const model = (chat: string, outgoing = false) => ({
    id: {
      id: "SAME",
      _serialized: `${outgoing}_${chat}_SAME`,
      remote: { _serialized: chat },
      fromMe: outgoing,
    },
    isNewMsg: true,
    type: "chat",
    get body() {
      reads++;
      return "SYNTHETIC";
    },
  });
  const a = model("100@c.us"),
    b = model("200@c.us"),
    outgoing = model("200@c.us", true);
  const models = [a, b, outgoing];
  const collections = {
    Chat: {
      findFirst: () => ({
        active: true,
        id: { _serialized: active },
        msgs: {
          getModelsArray: () => {
            throw new Error("Forbidden history scan");
          },
        },
      }),
    },
    Msg: {
      get: (id: string) => models.find((m) => m.id._serialized === id) ?? b,
    },
  };
  window.require = (() => collections) as any;
  document.body.innerHTML =
    '<main id="main"><div data-id="SAME" style="height:30px">Synthetic old A bubble</div></main>';
  const controller = new IncomingAnnotations<HTMLElement>({
    config: () => publicConfig(DEFAULT_CONFIG),
    enabledChat: () => true,
    activeChat: () => active,
    now: () => 0,
    bubble: findIncomingBubble,
    translate: () => {
      requests++;
      return new Promise(() => {});
    },
    show: () => {
      throw new Error("No pending result");
    },
  });
  for (const chat of ["100@c.us", "200@c.us", "100@c.us", "200@c.us"]) {
    active = chat;
    assert(
      resolveManualIncomingModel("SAME", chat, collections) === null,
      "raw manual must reject after switch",
    );
  }
  assert(reads === 0, "manual must not read B body");
  controller.add(b);
  assert(requests === 0, "old A raw bubble cannot authorize automatic B");
  document.querySelector("#main")!.innerHTML =
    '<div data-id="SAME" style="height:30px">Synthetic recycled bubble</div>';
  controller.refresh();
  assert(requests === 0, "replacement raw node remains unverified");
  assert(
    incomingBubbleReason(
      true,
      true,
      indexIncomingBubbles(document.querySelector("#main")),
      b.id._serialized,
      "SAME",
    ) === "render_unverified",
    "safe diagnostic",
  );
  const bubble = document.querySelector("[data-id]")!;
  bubble.setAttribute("data-id", a.id._serialized);
  controller.refresh();
  assert(
    requests === 0 && findIncomingBubble(a.id._serialized, "100@c.us") === null,
    "old full A cannot authorize B",
  );
  bubble.setAttribute("data-id", outgoing.id._serialized);
  controller.refresh();
  assert(
    requests === 0 &&
      resolveManualIncomingModel(
        outgoing.id._serialized,
        active,
        collections,
      ) === null,
    "outgoing rejected",
  );
  bubble.setAttribute("data-id", b.id._serialized);
  assert(
    resolveManualIncomingModel(b.id._serialized, active, collections) === b,
    "full B resolves",
  );
  controller.refresh();
  assert(requests === 1, "full B positive");
  controller.stop();
  bubble.setAttribute("data-id", "SAME");
  const root: any = { stateNode: {} };
  root.stateNode.current = root;
  const parent: any = { return: root, memoizedProps: { msg: a } };
  root.child = parent;
  const host: any = { return: parent, stateNode: bubble };
  parent.child = host;
  const stale: any = { return: parent, stateNode: bubble, alternate: host };
  (bubble as any).__reactFiber$synthetic = stale;
  assert(
    findIncomingBubble(b.id._serialized, active, "SAME") === null,
    "committed A DOM must reject B",
  );
  assert(
    resolveManualIncomingModel("SAME", active, collections) === null,
    "manual current B cannot select rendered A",
  );
  parent.memoizedProps.msg = b;
  assert(
    findIncomingBubble(b.id._serialized, active, "SAME") === bubble,
    "current alternate B is bound",
  );
  assert(
    resolveManualIncomingModel("SAME", active, collections) === b,
    "manual rendered B same store object",
  );
  root.memoizedProps = { msg: a };
  assert(
    findIncomingBubble(b.id._serialized, active, "SAME") === null,
    "conflicting committed ancestors reject",
  );
  delete root.memoizedProps;
  root.stateNode.current = {};
  assert(
    findIncomingBubble(b.id._serialized, active, "SAME") === null,
    "stale root rejects recycled node",
  );
  document.body.textContent = "PASS rendered identity synthetic DOM checks";
} catch (error) {
  document.body.textContent = "FAIL " + (error as Error).message;
}
