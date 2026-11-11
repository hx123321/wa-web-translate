import { installIncomingAnnotations } from "../src/page/hooks/incoming-annotations";
import { digestText } from "../src/page/translation-history";
import { DEFAULT_CONFIG, publicConfig } from "../src/shared/types";
const assert = (ok: unknown, text: string) => {
  if (!ok) throw Error(text);
};
(async () => {
  const chat = "100@c.us",
    account = await digestText("999@c.us"),
    originalHash = await digestText("ORIGINAL");
  const main = document.createElement("main");
  main.id = "main";
  document.body.append(main);
  const models = new Map<string, any>();
  let inView = true,
    requests = 0,
    fullScans = 0,
    maxIds = 0;
  const query = main.querySelectorAll.bind(main);
  main.querySelectorAll = ((selector: string) => {
    if (selector === "[data-id]") fullScans++;
    return query(selector);
  }) as any;
  for (let i = 0; i < 100; i++) {
    const id = `false_${chat}_M${i}`;
    models.set(id, {
      id: {
        _serialized: id,
        id: `M${i}`,
        remote: { _serialized: chat },
        fromMe: false,
      },
      type: "chat",
      body: "ORIGINAL",
      t: 1700000000,
    });
    const row = document.createElement("div");
    row.dataset.id = id;
    row.innerHTML =
      '<div class="copyable-text"><span class="selectable-text">ORIGINAL</span></div>';
    row.getClientRects = (() => [
      { x: 0, y: 0, width: 100, height: 20 },
    ]) as any;
    row.getBoundingClientRect = (() => ({
      top: inView ? 10 : 99999,
      bottom: inView ? 30 : 100019,
      left: 10,
      right: 110,
      width: 100,
      height: 20,
    })) as any;
    main.append(row);
  }
  window.require = ((name: string) =>
    name === "WAWebUserPrefsMeUser"
      ? { getMaybeMePnUser: () => ({ _serialized: "999@c.us" }) }
      : {
          Chat: {
            findFirst: () => ({ active: true, id: { _serialized: chat } }),
          },
          Msg: { get: (id: string) => models.get(id), on() {}, off() {} },
        }) as any;
  window.dispatchEvent(
    new MessageEvent("message", {
      source: window,
      data: {
        __waTransStore: true,
        kind: "STORE_PUSH",
        config: { ...publicConfig(DEFAULT_CONFIG), revision: "test" },
        chatLangs: { [chat]: { incoming: "zh-CN", outgoing: null } },
      },
    }),
  );
  window.addEventListener("message", (e) => {
    if (e.data?.__waTransHistory !== true || e.data.kind !== "HISTORY_REQUEST")
      return;
    requests++;
    maxIds = Math.max(maxIds, e.data.ids?.length ?? 0);
    const records = (e.data.ids ?? []).map((id: string) => ({
      account,
      id,
      chat,
      rawId: models.get(id).id.id,
      originalHash,
      target: "zh-CN",
      revision: "test",
      translated: "TRANSLATED",
      source: "en",
      savedAt: Date.now(),
      messageAt: 1700000000000,
      dateBasis: "message",
    }));
    window.postMessage(
      {
        __waTransHistory: true,
        kind: "HISTORY_RESULT",
        id: e.data.id,
        result: { status: "ok", records, locationKey: "fixture" },
      },
      "*",
    );
  });
  assert(installIncomingAnnotations(), "installation");
  const delay = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));
  for (
    let i = 0;
    i < 40 && main.querySelectorAll(".wa-translate-incoming-note").length < 100;
    i++
  )
    await delay(25);
  assert(
    main.querySelectorAll(".wa-translate-incoming-note").length === 100,
    "cold restores all100",
  );
  assert(fullScans < 12, `cold full scans ${fullScans}`);
  const coldScans = fullScans;
  const initialRequests = requests;
  fullScans = 0;
  await delay(1100);
  assert(fullScans < 10, `warm full scans ${fullScans}`);
  assert(requests === initialRequests, "warm no history reload");
  const warmScans = fullScans;
  inView = false;
  await delay(1100);
  assert(
    main.querySelectorAll(".wa-translate-incoming-note").length === 0,
    "offscreen notes released",
  );
  inView = true;
  await delay(1100);
  assert(
    main.querySelectorAll(".wa-translate-incoming-note").length === 100,
    "scroll back reloads cache",
  );
  assert(maxIds <= 100 && requests <= 4, "bounded cache requests");
  window.dispatchEvent(new Event("pagehide"));
  document.body.textContent = `PASS production history cold/warm/scroll DOM integration (cold scans=${coldScans}, warm scans=${warmScans}, requests=${requests})`;
})().catch((e) => {
  window.dispatchEvent(new Event("pagehide"));
  document.body.textContent = "FAIL " + e.message;
});
