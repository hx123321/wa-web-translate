import assert from "node:assert/strict";
import { directions, normalizeDirections } from "../src/shared/chat-directions";
import { loadChatLangs, setChatLang, saveConfig } from "../src/shared/storage";
import { DEFAULT_CONFIG } from "../src/shared/types";
export async function runDirectionsTests(): Promise<number> {
  assert.deepEqual(directions("fr", "zh-CN"), {
    incoming: "zh-CN",
    outgoing: "fr",
  });
  assert.deepEqual(directions(undefined, "zh-CN"), {
    incoming: null,
    outgoing: null,
  });
  assert.deepEqual(directions({ incoming: "ja", outgoing: null }, "zh-CN"), {
    incoming: "ja",
    outgoing: null,
  });
  assert.deepEqual(
    normalizeDirections({ "title:Unsafe": "fr", "101@c.us": "fr" }, "zh-CN"),
    { "101@c.us": { incoming: "zh-CN", outgoing: "fr" } },
  );
  console.log(
    "PASS Direction migration enables only previously configured verified chats",
  );
  const old = (globalThis as any).chrome;
  const data: any = {
    config: { ...DEFAULT_CONFIG, nativeLang: "zh-CN" },
    chatLangs: { "101@c.us": "fr" },
  };
  try {
    (globalThis as any).chrome = {
      storage: {
        local: {
          get: async (key: string) => ({ [key]: data[key] }),
          set: async (patch: any) => {
            Object.assign(data, patch);
          },
        },
      },
    };
    await loadChatLangs();
    await saveConfig({ nativeLang: "en" });
    assert.deepEqual((await loadChatLangs())["101@c.us"], {
      incoming: "zh-CN",
      outgoing: "fr",
    });
    await Promise.all([
      setChatLang("101@c.us", "ja", "incoming"),
      setChatLang("101@c.us", null, "outgoing"),
    ]);
    assert.deepEqual((await loadChatLangs())["101@c.us"], {
      incoming: "ja",
      outgoing: null,
    });
    await setChatLang("202@c.us", "de", "outgoing");
    assert.deepEqual((await loadChatLangs())["202@c.us"], {
      incoming: null,
      outgoing: "de",
    });
    await setChatLang("202@c.us", "zh-CN", "incoming");
    await setChatLang("202@c.us", null, "incoming");
    assert.deepEqual((await loadChatLangs())["202@c.us"], {
      incoming: null,
      outgoing: "de",
    });
    await assert.rejects(() => setChatLang("title:bad", "fr", "incoming"));
    await assert.rejects(() => setChatLang("202@c.us", "invalid", "incoming"));
  } finally {
    (globalThis as any).chrome = old;
  }
  console.log(
    "PASS Persisted directions are independent, serialized and retain migration target across native changes",
  );
  const { renderToStaticMarkup } = await import("react-dom/server.browser");
  const { createElement } = await import("react");
  const { DirectionPanel } = await import("../src/page/ui/DirectionPanel");
  const html = renderToStaticMarkup(
    createElement(DirectionPanel, { chatId: "909@c.us" }),
  );
  for (const label of [
    "接收翻译",
    "发送翻译",
    "搜索语言",
    "自动识别来源",
    "关闭接收翻译",
  ])
    assert(html.includes(label));
  console.log(
    "PASS Existing direction panel renders Chinese independent controls and searchable languages",
  );
  return 3;
}
