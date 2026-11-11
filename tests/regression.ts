import { quickChoices, selectedChoice } from "../src/shared/quick-providers";
import { selectTranslationChoice } from "../src/shared/storage";
import {
  loadConfig,
  saveConfig,
  approveCustomCredential,
} from "../src/shared/storage";
import { TranslationGate } from "../src/background/request-gate";
import { microsoftCode, internalCode } from "../src/background/services";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, publicConfig, configured } from "../src/shared/types";
import { customEndpoint } from "../src/shared/endpoint";
import { jsonRequest } from "../src/background/http";
import { chunks, translateService } from "../src/background/services";
import { callModel } from "../src/background/providers";
let count = 0;
async function check(name: string, fn: () => unknown) {
  await fn();
  count++;
  console.log("PASS", name);
}
const response = (v: any) =>
  new Response(JSON.stringify(v), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
await check("Public configuration excludes secrets and endpoint", () => {
  const p = publicConfig({
    ...DEFAULT_CONFIG,
    apiKeys: { custom: "SECRET" },
    customBaseUrl: "https://private.example",
  });
  assert(!JSON.stringify(p).includes("SECRET"));
  assert(!("apiKeys" in p));
  assert(!("customBaseUrl" in p));
});
await check("Keyless status", () => {
  assert(configured({ ...DEFAULT_CONFIG, mode: "service" }));
  assert(!configured(DEFAULT_CONFIG));
});
await check("Custom endpoint validation", () => {
  assert.equal(
    customEndpoint("https://example.com/v1/").href,
    "https://example.com/v1/chat/completions",
  );
  for (const u of [
    "http://example.com",
    "https://a:b@example.com",
    "https://example.com?q=x",
    "https://example.com#x",
    "https://localhost",
    "https://127.0.0.1",
  ])
    assert.throws(() => customEndpoint(u));
});
await check("Unicode chunking preserves text", () => {
  const s = "x".repeat(999) + "😀" + "y".repeat(2000);
  const c = chunks(s);
  assert.equal(c.join(""), s);
  assert(c.every((x) => x.length <= 1000));
  assert(!/[\uD800-\uDBFF]$/.test(c[0]));
});
await check("Google keyless response and outgoing request", async () => {
  globalThis.fetch = async (u, init) => {
    assert(
      String(u).startsWith("https://translate.google.com/translate_a/single?"),
    );
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.redirect, "error");
    assert(!(init?.headers as any)?.authorization);
    return response([[["你好", "Hello"]], null, "en"]);
  };
  assert.equal(
    (
      await translateService("google", {
        text: "Hello",
        target: "zh-CN",
        source: "auto",
      })
    ).translated,
    "你好",
  );
});
await check("Malformed provider response rejected", async () => {
  globalThis.fetch = async () => response({ broken: true });
  await assert.rejects(() =>
    translateService("google", { text: "Hello", target: "fr" }),
  );
});
await check("HTTP error is sanitized", async () => {
  globalThis.fetch = async () => new Response("SECRET", { status: 429 });
  await assert.rejects(
    () => jsonRequest("https://example.com"),
    (e) => String(e).includes("429") && !String(e).includes("SECRET"),
  );
});
await check("Oversized response rejected", async () => {
  globalThis.fetch = async () => new Response("x".repeat(1048577));
  await assert.rejects(() => jsonRequest("https://example.com"), /too large/);
});
await check("Abort is propagated", async () => {
  globalThis.fetch = async (_u, i) => {
    assert(i?.signal);
    throw new DOMException("aborted", "AbortError");
  };
  await assert.rejects(() => jsonRequest("https://example.com"));
});
await check("DeepSeek endpoint and selected key", async () => {
  globalThis.fetch = async (u, i) => {
    assert.equal(u, "https://api.deepseek.com/chat/completions");
    assert.equal((i?.headers as any).authorization, "Bearer DEEP");
    assert.deepEqual(JSON.parse(i?.body as string).thinking, {
      type: "disabled",
    });
    return response({ choices: [{ message: { content: "bonjour" } }] });
  };
  assert.equal(
    await callModel(
      {
        ...DEFAULT_CONFIG,
        provider: "deepseek",
        apiKeys: { deepseek: "DEEP", openai: "OTHER" },
      },
      { system: "Translate", user: "Hello" },
    ),
    "bonjour",
  );
});
await check(
  "Thinking off uses exact documented models or explicit custom format",
  async () => {
    const { thinkingOffFields } = await import("../src/background/thinking");
    const fields = (
      provider: any,
      model: string,
      customThinking: any = "omit",
    ) =>
      thinkingOffFields({
        ...DEFAULT_CONFIG,
        provider,
        model: { [provider]: model },
        customThinking,
      });
    assert.deepEqual(fields("deepseek", "deepseek-v4-pro"), {
      thinking: { type: "disabled" },
    });
    assert.deepEqual(fields("anthropic", "claude-sonnet-4-6"), {
      thinking: { type: "disabled" },
    });
    assert.deepEqual(fields("google", "gemini-2.5-flash"), {
      generationConfig: { thinkingConfig: { thinkingBudget: 0 } },
    });
    assert.deepEqual(fields("openai", "gpt-5.2"), { reasoning_effort: "none" });
    for (const [p, m] of [
      ["openai", "gpt-6.1"],
      ["google", "gemini-2.5-pro"],
      ["anthropic", "claude-opus-5-5"],
      ["deepseek", "unknown"],
    ])
      assert.deepEqual(fields(p, m), {});
    assert.deepEqual(fields("custom", "deepseek-flash"), {});
    assert.deepEqual(fields("custom", "unknown", "thinking_disabled"), {
      thinking: { type: "disabled" },
    });
    assert.deepEqual(fields("custom", "unknown", "reasoning_none"), {
      reasoning_effort: "none",
    });
  },
);
let storedConfig: any = {};
let permission = false;
function storageMock() {
  (globalThis as any).chrome = {
    permissions: { contains: async () => permission },
    storage: {
      local: {
        get: async () => ({ config: structuredClone(storedConfig) }),
        set: async (v: any) => {
          storedConfig = structuredClone(v.config);
        },
      },
    },
  };
}
storageMock();
await check(
  "Old settings migrate without approving legacy custom keys",
  async () => {
    storedConfig = {
      provider: "openai",
      apiKeys: { openai: "ORIGINAL", custom: "LEGACY" },
      model: { openai: "old-model" },
    };
    const c = await loadConfig();
    assert.equal(c.mode, "llm");
    assert.equal(c.service, "google");
    assert.equal(c.apiKeys.openai, "ORIGINAL");
    assert.equal(c.model.openai, "old-model");
    assert.equal(c.apiKeys.custom, undefined);
    assert.equal(c.customCredential, null);
  },
);
await check(
  "Preauthorized provider origins do not approve a custom key",
  async () => {
    permission = true;
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return response({});
    };
    for (const customBaseUrl of [
      "https://api.openai.com/v1",
      "https://api.deepseek.com",
    ]) {
      await assert.rejects(
        () =>
          callModel(
            {
              ...DEFAULT_CONFIG,
              provider: "custom",
              customBaseUrl,
              apiKeys: { custom: "LEGACY" },
              model: { custom: "model" },
            },
            { system: "T", user: "x" },
          ),
        /approve/,
      );
    }
    assert.equal(calls, 0);
  },
);
await check("Approval binds the exact endpoint and custom key", async () => {
  storedConfig = { ...DEFAULT_CONFIG };
  permission = false;
  await saveConfig({
    provider: "custom",
    customBaseUrl: "https://example.com/v1",
    model: { custom: "my-model" },
  });
  let c = await saveConfig({ apiKeys: { custom: "CUSTOM", openai: "OTHER" } });
  const expected = {
    customBaseUrl: c.customBaseUrl,
    customRevision: c.customRevision,
    key: "CUSTOM",
  };
  await assert.rejects(() => approveCustomCredential(expected), /permission/);
  permission = true;
  c = await approveCustomCredential(expected);
  assert.equal(
    c.customCredential?.endpoint,
    "https://example.com/v1/chat/completions",
  );
  globalThis.fetch = async (u, i) => {
    assert.equal(u, "https://example.com/v1/chat/completions");
    assert.equal((i?.headers as any).authorization, "Bearer CUSTOM");
    return response({ choices: [{ message: { content: "ok" } }] });
  };
  assert.equal(await callModel(c, { system: "T", user: "x" }), "ok");
});
await check(
  "URL edit clears key and approval, including return to old URL",
  async () => {
    const old = await loadConfig();
    let c = await saveConfig({
      customBaseUrl: "https://example.com/v2",
      customCredential: {
        endpoint: "https://example.com/v2/chat/completions",
        key: "FORGED",
      },
    });
    assert.equal(c.apiKeys.custom, undefined);
    assert.equal(c.customCredential, null);
    c = await saveConfig({ customBaseUrl: old.customBaseUrl });
    assert.equal(c.customCredential, null);
    assert.equal(c.apiKeys.custom, undefined);
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return response({});
    };
    await assert.rejects(
      () => callModel(old, { system: "T", user: "x" }),
      /changed/,
    );
    await assert.rejects(
      () => callModel(c, { system: "T", user: "x" }),
      /approve/,
    );
    assert.equal(calls, 0);
  },
);
await check(
  "Key edit invalidates approval and pending old approval",
  async () => {
    let c = await saveConfig({ apiKeys: { custom: "ONE" } });
    const expected = {
      customBaseUrl: c.customBaseUrl,
      customRevision: c.customRevision,
      key: "ONE",
    };
    c = await approveCustomCredential(expected);
    assert(configured(c));
    c = await saveConfig({ apiKeys: { custom: "TWO" } });
    assert.equal(c.customCredential, null);
    assert(!configured(c));
    await assert.rejects(() => approveCustomCredential(expected), /changed/);
  },
);
await check(
  "Edit during permission check prevents approval and key dispatch",
  async () => {
    let c = await loadConfig();
    const expected = {
      customBaseUrl: c.customBaseUrl,
      customRevision: c.customRevision,
      key: c.apiKeys.custom!,
    };
    (globalThis as any).chrome.permissions.contains = async () => {
      storedConfig = {
        ...storedConfig,
        customRevision: "concurrent-edit",
        customBaseUrl: "https://api.openai.com/v1",
        customCredential: null,
      };
      return true;
    };
    await assert.rejects(() => approveCustomCredential(expected), /changed/);
    storageMock();
    c = await saveConfig({ customBaseUrl: "https://example.com/v1" });
    c = await saveConfig({ apiKeys: { custom: "SAFE" } });
    c = await approveCustomCredential({
      customBaseUrl: c.customBaseUrl,
      customRevision: c.customRevision,
      key: "SAFE",
    });
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return response({});
    };
    (globalThis as any).chrome.permissions.contains = async () => {
      storedConfig = {
        ...storedConfig,
        customRevision: "changed-again",
        customCredential: null,
      };
      return true;
    };
    await assert.rejects(
      () => callModel(c, { system: "T", user: "x" }),
      /changed/,
    );
    assert.equal(calls, 0);
    storageMock();
  },
);
await check("Microsoft Filipino and Norwegian mapping is bidirectional", () => {
  assert.equal(microsoftCode("tl"), "fil");
  assert.equal(microsoftCode("no"), "nb");
  assert.equal(internalCode("fil"), "tl");
  assert.equal(internalCode("nb"), "no");
});
await check(
  "Fetch is actually aborted when the configured deadline fires",
  async () => {
    const original = AbortSignal.timeout;
    let deadline = 0;
    AbortSignal.timeout = (ms: number) => {
      deadline = ms;
      return original(5);
    };
    const keepAlive = setTimeout(() => {}, 100);
    globalThis.fetch = async (_u, i) =>
      new Promise((_resolve, reject) => {
        assert(i?.signal);
        i.signal!.addEventListener("abort", () => reject(i.signal!.reason), {
          once: true,
        });
      });
    try {
      await assert.rejects(
        () => jsonRequest("https://example.com"),
        (e) => (e as Error).name === "TimeoutError",
      );
      assert.equal(deadline, 20000);
    } finally {
      AbortSignal.timeout = original;
      clearTimeout(keepAlive);
    }
  },
);
await check(
  "Rate limit enforces 60 per minute and resets with the clock",
  async () => {
    const gate = new TranslationGate();
    let now = 100000;
    const original = Date.now;
    Date.now = () => now;
    try {
      for (let i = 0; i < 60; i++)
        await gate.run({ text: "x", target: "fr" }, async () => true);
      await assert.rejects(
        () => gate.run({ text: "x", target: "fr" }, async () => true),
        /busy/,
      );
      now += 60000;
      assert(await gate.run({ text: "x", target: "fr" }, async () => true));
    } finally {
      Date.now = original;
    }
  },
);
await check(
  "Concurrency slots recover after failures and invalid input never runs",
  async () => {
    const gate = new TranslationGate();
    const releases: (() => void)[] = [];
    const pending = Array.from({ length: 4 }, () =>
      gate.run(
        { text: "x", target: "fr" },
        () => new Promise<void>((r) => releases.push(r)),
      ),
    );
    await assert.rejects(
      () => gate.run({ text: "x", target: "fr" }, async () => true),
      /busy/,
    );
    releases.forEach((r) => r());
    await Promise.all(pending);
    await assert.rejects(
      () =>
        gate.run({ text: "x", target: "fr" }, async () => {
          throw new Error("provider failed");
        }),
      /provider failed/,
    );
    assert(await gate.run({ text: "x", target: "fr" }, async () => true));
    let calls = 0;
    for (const req of [
      { text: 4, target: "fr" },
      { text: "x".repeat(5001), target: "fr" },
      { text: "x", target: {} },
      { text: "x", target: "fr", source: {} },
    ])
      await assert.rejects(
        () =>
          gate.run(req as any, async () => {
            calls++;
          }),
        /Invalid/,
      );
    assert.equal(calls, 0);
  },
);
await check("Microsoft keyless language mapping", async () => {
  globalThis.fetch = async (u, i) =>
    String(u).includes("/auth")
      ? new Response("abc.def.ghi")
      : (assert(String(u).includes("to=zh-Hans")),
        assert.equal((i?.headers as any).authorization, "Bearer abc.def.ghi"),
        response([
          {
            translations: [{ text: "你好" }],
            detectedLanguage: { language: "en" },
          },
        ]));
  assert.equal(
    (await translateService("microsoft", { text: "hello", target: "zh-CN" }))
      .translated,
    "你好",
  );
});
// Exercise the real send hook with page-side RPC and store events mocked.
const listeners: ((e: any) => void)[] = [];
let sends = 0;
let rpcFails = true;
const mod = {
  sendTextMsgToChat: async () => {
    sends++;
    throw new Error("network send failed");
  },
};
(globalThis as any).window = {
  dispatchEvent: () => true,
  addEventListener: (n: string, f: any) => {
    if (n === "message") listeners.push(f);
  },
  require: (name: string) =>
    name === "WAWebSendTextMsgChatAction" ? mod : null,
  postMessage: (m: any) => {
    if (m.kind === "TRANSLATE_REQUEST")
      queueMicrotask(() =>
        listeners.forEach((f) =>
          f({
            source: window,
            data: {
              __waTrans: true,
              kind: "TRANSLATE_RESULT",
              id: m.id,
              ok: !rpcFails,
              error: "failed",
              result: { translated: "Bonjour", target: "fr", source: "en" },
            },
          }),
        ),
      );
  },
};
const { installSendHook } = await import("../src/page/hooks/send");
const { activateDraft, sessions } = await import("../src/page/hooks/composer");
installSendHook();
listeners.forEach((f) =>
  f({
    source: window,
    data: {
      __waTransStore: true,
      kind: "STORE_PUSH",
      config: publicConfig(DEFAULT_CONFIG),
      chatLangs: { "123@c.us": "fr" },
    },
  }),
);
await check("Activated translation failure never sends raw text", async () => {
  await activateDraft("123@c.us", "Hello");
  await assert.rejects(() =>
    mod.sendTextMsgToChat({ id: { _serialized: "123@c.us" } }, "Hello"),
  );
  assert.equal(sends, 0);
});
await check("Send rejection is never retried", async () => {
  rpcFails = false;
  await activateDraft("123@c.us", "Hello");
  await assert.rejects(() =>
    mod.sendTextMsgToChat({ id: { _serialized: "123@c.us" } }, "Hello"),
  );
  assert.equal(sends, 1);
});
await check(
  "Unknown provider never falls back with a foreign key",
  async () => {
    await assert.rejects(
      () =>
        callModel(
          {
            ...DEFAULT_CONFIG,
            provider: "unknown" as any,
            apiKeys: { unknown: "FOREIGN" } as any,
          },
          { system: "x", user: "y" },
        ),
      /Invalid provider/,
    );
  },
);
await check(
  "Late translation cannot repopulate cache after config change",
  async () => {
    const { maybeTranslateResult } = await import(
      "../src/page/hooks/incoming-decrypt"
    );
    const queued: any[] = [];
    window.postMessage = (m: any) => {
      if (m.kind === "TRANSLATE_REQUEST") queued.push(m);
    };
    const first = { conversation: "Original" };
    const pending = maybeTranslateResult(first, "123@c.us");
    assert.equal(queued.length, 1);
    listeners.forEach((f) =>
      f({
        source: window,
        data: {
          __waTransStore: true,
          kind: "STORE_PUSH",
          config: publicConfig({ ...DEFAULT_CONFIG, provider: "deepseek" }),
        },
      }),
    );
    const finish = (m: any, text: string) =>
      listeners.forEach((f) =>
        f({
          source: window,
          data: {
            __waTrans: true,
            kind: "TRANSLATE_RESULT",
            id: m.id,
            ok: true,
            result: { translated: text, target: "fr", source: "en" },
          },
        }),
      );
    finish(queued[0], "STALE");
    await pending;
    assert.equal(first.conversation, "Original");
    const second = { conversation: "Original" };
    const fresh = maybeTranslateResult(second, "123@c.us");
    assert.equal(queued.length, 2);
    finish(queued[1], "Fresh");
    await fresh;
    assert(second.conversation.startsWith("Fresh"));
    assert(!second.conversation.includes("STALE"));
  },
);

await check(
  "Google whitespace segments are retained and malformed segments rejected",
  async () => {
    globalThis.fetch = async () =>
      response([
        [
          ["Hello", "Hello"],
          ["\n", "\n"],
          ["world", "world"],
        ],
        null,
        "en",
      ]);
    assert.equal(
      (await translateService("google", { text: "Hello\nworld", target: "fr" }))
        .translated,
      "Hello\nworld",
    );
    globalThis.fetch = async () => response([[[42]], null, "en"]);
    await assert.rejects(
      () => translateService("google", { text: "Hello", target: "fr" }),
      /Invalid Google response/,
    );
    globalThis.fetch = async () => response([[["\n"]], null, "en"]);
    await assert.rejects(
      () => translateService("google", { text: "Hello", target: "fr" }),
      /empty translation/,
    );
  },
);
await check(
  "Unknown decrypt signature returns exact original without decoding or translating",
  async () => {
    const { installDecryptHook, decryptChatId } = await import(
      "../src/page/hooks/incoming-decrypt"
    );
    assert.equal(decryptChatId([]), null);
    assert.equal(decryptChatId([{}, null]), null);
    assert.equal(decryptChatId([{}, { _serialized: 42 }]), null);
    assert.equal(decryptChatId([{}, { _serialized: "456@c.us" }]), "456@c.us");
    const original = new Uint8Array([1, 2, 3]);
    let decoderLookups = 0;
    let rpcCalls = 0;
    const decryptModule = { decryptEnc: async (..._args: any[]) => original };
    window.require = (name: string) => {
      if (name === "WAWebMsgProcessingDecryptEnc") return decryptModule;
      decoderLookups++;
      return null;
    };
    window.postMessage = () => {
      rpcCalls++;
    };
    assert(installDecryptHook());
    assert.equal(await decryptModule.decryptEnc({}), original);
    assert.equal(await decryptModule.decryptEnc({}, undefined), original);
    assert.equal(decoderLookups, 0);
    assert.equal(rpcCalls, 0);
    // A known identifier but unavailable decoder modules also preserves exact bytes.
    assert.equal(
      await decryptModule.decryptEnc({}, { _serialized: "456@c.us" }),
      original,
    );
    assert.equal(rpcCalls, 0);
  },
);
await check(
  "Picker floats on body at the right edge without occupying composer layout",
  async () => {
    // Import React before installing the lightweight DOM stub.
    const { ensurePickerHost } = await import("../src/page/ui/mount");
    const { findComposer } = await import("../src/page/composer-dom");
    const hosts = new Map<string, any>();
    let inserts = 0;
    const area: any = {
      getBoundingClientRect: () => ({ top: 600, right: 900 }),
      querySelector: () => null,
      insertBefore: (host: any, before: any) => {
        assert.equal(before, null);
        host.parentElement = area;
        hosts.set(host.id, host);
        inserts++;
      },
    };
    const row: any = { parentElement: area };
    const composer: any = {
      closest: () => null,
      parentElement: row,
      getBoundingClientRect: () => ({
        top: 600,
        bottom: 640,
        width: 500,
        height: 40,
      }),
    };
    const main: any = { querySelectorAll: () => [composer] };
    const body: any = {
      appendChild: (host: any) => {
        host.parentElement = body;
        hosts.set(host.id, host);
        inserts++;
      },
    };
    (window as any).innerWidth = 1000;
    (window as any).innerHeight = 800;
    const originalResizeObserver = (globalThis as any).ResizeObserver;
    (globalThis as any).ResizeObserver = class {
      observe() {}
      disconnect() {}
    };
    (globalThis as any).document = {
      body,
      head: { appendChild() {} },
      querySelector: (q: string) => (q === "#main" ? main : null),
      getElementById: (id: string) => hosts.get(id) ?? null,
      createElement: () => ({
        style: {},
        remove() {},
        addEventListener() {},
        removeEventListener() {},
        getBoundingClientRect: () => ({ width: 80, height: 40 }),
      }),
    };
    assert.equal(findComposer(), composer);
    const host = ensurePickerHost();
    assert(host);
    assert.equal(host.parentElement, body);
    assert.equal(host.style.left, "890px");
    assert.equal(host.style.top, "546px");
    assert.equal(inserts, 1);
    assert.equal(ensurePickerHost(), host);
    assert.equal(inserts, 1);
    (globalThis as any).document.querySelector = () => null;
    assert.equal(findComposer(), null);
    assert.equal(ensurePickerHost(), host);
    assert.equal(host.style.display, "none");
    (globalThis as any).ResizeObserver = originalResizeObserver;
    delete (globalThis as any).document;
  },
);

await check(
  "Titles and header data-id never become a chat identity",
  async () => {
    const { getActiveChatId } = await import("../src/page/wa");
    (globalThis as any).document = {
      querySelector: () => {
        throw new Error("DOM identity must not be inspected");
      },
    };
    window.require = () => null;
    assert.equal(getActiveChatId(), null);
    window.require = () => ({
      ChatCollection: {
        getActive: () => ({ id: { _serialized: "789@c.us" } }),
      },
    });
    assert.equal(getActiveChatId(), "789@c.us");
    window.require = () => ({
      ChatCollection: {
        getActive: () => ({ id: { _serialized: "title:Same name" } }),
      },
    });
    assert.equal(getActiveChatId(), null);
    delete (globalThis as any).document;
  },
);
await check(
  "Unknown identity or a changed chat cannot persist language settings",
  async () => {
    const { setChatLang, getChatLang } = await import("../src/page/store");
    let writes = 0;
    window.postMessage = () => {
      writes++;
    };
    window.require = () => null;
    assert.equal(setChatLang("title:Same name", "fr"), false);
    assert.equal(setChatLang("unverified-header-id", "fr"), false);
    assert.equal(setChatLang("", "fr"), false);
    assert.equal(writes, 0);
    assert.equal(getChatLang("unverified-header-id"), null);
    window.require = () => ({
      ChatCollection: {
        getActive: () => ({ id: { _serialized: "800@c.us" } }),
      },
    });
    assert.equal(setChatLang("801@c.us", "fr"), false);
    assert.equal(writes, 0);
    assert.equal(setChatLang("800@c.us", "fr"), true);
    assert.equal(writes, 1);
  },
);
await check(
  "Unknown outbound identity never requests translation",
  async () => {
    let requests = 0;
    window.postMessage = (m: any) => {
      if (m.kind === "TRANSLATE_REQUEST") requests++;
    };
    // Existing test sender throws after counting a normal send. No real message is sent.
    await assert.rejects(() => mod.sendTextMsgToChat({}, "Hello"));
    assert.equal(requests, 0);
  },
);

await check(
  "Modern active collection uses serialized or $1 Wid without probing legacy",
  async () => {
    const { getActiveChatId } = await import("../src/page/wa");
    const { serializedWid } = await import("../src/page/chat-id");
    const queried: string[] = [];
    window.require = (name: string) => {
      queried.push(name);
      assert.equal(name, "WAWebCollections");
      return {
        Chat: {
          findFirst: (predicate: any) =>
            [
              { active: false, id: { _serialized: "900@c.us" } },
              { active: true, id: { $1: "901@lid" } },
            ].find(predicate),
        },
      };
    };
    assert.equal(getActiveChatId(), "901@lid");
    assert.deepEqual(queried, ["WAWebCollections"]);
    assert.equal(serializedWid({ $1: "901@lid" }), "901@lid");
    for (const wid of [
      { _serialized: "title:Person" },
      { _serialized: "header-id" },
      { __x_id: "901@lid" },
      { _serialized: "a@evil.invalid" },
      "901@lid",
    ])
      assert.equal(serializedWid(wid), null);
    window.require = (name: string) => {
      assert.equal(name, "WAWebCollections");
      return {
        Chat: {
          getModelsArray: () => [
            { active: true, id: { _serialized: "902@g.us" } },
          ],
        },
      };
    };
    assert.equal(getActiveChatId(), "902@g.us");
  },
);
await check(
  "Popup lists only configured models and always offers keyless services",
  () => {
    const c = {
      ...DEFAULT_CONFIG,
      apiKeys: { openai: "KEY", deepseek: "KEY" },
      model: { openai: "model", deepseek: "" },
    };
    const ids = quickChoices(c).map((x) => x.id);
    assert.deepEqual(ids, [
      "llm:openai",
      "service:google",
      "service:microsoft",
    ]);
    assert(!ids.includes("llm:custom"));
  },
);
await check(
  "Popup persists mode/provider/service choices without changing other provider preferences",
  async () => {
    storageMock();
    permission = true;
    storedConfig = {
      ...DEFAULT_CONFIG,
      apiKeys: { openai: "KEY" },
      model: { ...DEFAULT_CONFIG.model, openai: "my-model" },
    };
    let c = await selectTranslationChoice("service:google");
    assert.equal(selectedChoice(c), "service:google");
    c = await selectTranslationChoice("service:microsoft");
    assert.equal(selectedChoice(await loadConfig()), "service:microsoft");
    c = await selectTranslationChoice("llm:openai");
    assert.equal(selectedChoice(await loadConfig()), "llm:openai");
    assert.equal(c.service, "microsoft");
    assert.equal(c.apiKeys.openai, "KEY");
    await assert.rejects(
      () => selectTranslationChoice("llm:deepseek"),
      /not configured/,
    );
    assert.equal(selectedChoice(await loadConfig()), "llm:openai");
  },
);
await check(
  "Popup rejects stale or permission-revoked custom approvals instead of falling back",
  async () => {
    let c = await saveConfig({
      customBaseUrl: "https://example.com/v1",
      model: { custom: "custom-model" },
    });
    c = await saveConfig({ apiKeys: { custom: "KEY" } });
    permission = true;
    c = await approveCustomCredential({
      customBaseUrl: c.customBaseUrl,
      customRevision: c.customRevision,
      key: "KEY",
    });
    assert(quickChoices(c).some((x) => x.id === "llm:custom"));
    await selectTranslationChoice("llm:custom");
    await selectTranslationChoice("service:google");
    permission = false;
    await assert.rejects(
      () => selectTranslationChoice("llm:custom"),
      /permission/,
    );
    assert.equal(selectedChoice(await loadConfig()), "service:google");
    permission = true;
    await saveConfig({ apiKeys: { custom: "CHANGED" } });
    assert(
      !quickChoices(await loadConfig()).some((x) => x.id === "llm:custom"),
    );
    await assert.rejects(
      () => selectTranslationChoice("llm:custom"),
      /not configured/,
    );
    assert.equal(selectedChoice(await loadConfig()), "service:google");
  },
);

await check(
  "Picker and send hook use the same current $1 Wid identity",
  async () => {
    const { getActiveChatId } = await import("../src/page/wa");
    const { setChatLang } = await import("../src/page/store");
    const id = { $1: "1001@lid" };
    window.require = (name: string) =>
      name === "WAWebCollections"
        ? {
            Chat: {
              findFirst: (fn: any) =>
                fn({ active: true, id }) ? { active: true, id } : null,
            },
          }
        : null;
    let translations = 0;
    window.postMessage = (m: any) => {
      if (m.kind === "TRANSLATE_REQUEST") {
        translations++;
        assert.equal(m.payload.target, "fr");
        assert.equal(m.payload.source, "auto");
        queueMicrotask(() =>
          listeners.forEach((f) =>
            f({
              source: window,
              data: {
                __waTrans: true,
                kind: "TRANSLATE_RESULT",
                id: m.id,
                ok: true,
                result: { translated: "Bonjour", source: "en", target: "fr" },
              },
            }),
          ),
        );
      }
    };
    assert.equal(getActiveChatId(), "1001@lid");
    assert(setChatLang(getActiveChatId()!, "fr"));
    await activateDraft("1001@lid", "Hello");
    await assert.rejects(
      () => mod.sendTextMsgToChat({ id }, "Hello"),
      /network send failed/,
    );
    assert.equal(translations, 1);
  },
);

await check(
  "A provider switch during outgoing translation prevents stale send",
  async () => {
    const before = sends;
    window.postMessage = (m: any) => {
      if (m.kind !== "TRANSLATE_REQUEST") return;
      queueMicrotask(() => {
        listeners.forEach((f) =>
          f({
            source: window,
            data: {
              __waTransStore: true,
              kind: "STORE_PUSH",
              config: publicConfig({
                ...DEFAULT_CONFIG,
                mode: "service",
                service: "microsoft",
              }),
            },
          }),
        );
        listeners.forEach((f) =>
          f({
            source: window,
            data: {
              __waTrans: true,
              kind: "TRANSLATE_RESULT",
              id: m.id,
              ok: true,
              result: { translated: "Bonjour", source: "en", target: "fr" },
            },
          }),
        );
      });
    };
    await activateDraft("1001@lid", "Synthetic input");
    await assert.rejects(
      () =>
        mod.sendTextMsgToChat({ id: { $1: "1001@lid" } }, "Synthetic input"),
      /not sent/,
    );
    assert.equal(sends, before);
  },
);

await check(
  "Send consumes activated preview without new RPC; bilingual labels removed and raw send remains ordinary",
  async () => {
    const bodies: string[] = [];
    let requests = 0;
    const sender = {
      sendTextMsgToChat: async (_chat: any, body: string) => {
        bodies.push(body);
        return "sent";
      },
    };
    window.require = (name: string) =>
      name === "WAWebSendTextMsgChatAction" ? sender : null;
    installSendHook();
    window.postMessage = (m: any) => {
      if (m.kind !== "TRANSLATE_REQUEST") return;
      requests++;
      queueMicrotask(() =>
        listeners.forEach((f) =>
          f({
            source: window,
            data: {
              __waTrans: true,
              kind: "TRANSLATE_RESULT",
              id: m.id,
              ok: true,
              result: { translated: "Bonjour", source: "en", target: "fr" },
            },
          }),
        ),
      );
    };
    const config = (sendBoth: boolean, enabled = true) =>
      listeners.forEach((f) =>
        f({
          source: window,
          data: {
            __waTransStore: true,
            kind: "STORE_PUSH",
            config: publicConfig({ ...DEFAULT_CONFIG, sendBoth, enabled }),
            chatLangs: { "333@c.us": { incoming: "zh-CN", outgoing: "fr" } },
          },
        }),
      );
    const chat = { id: { _serialized: "333@c.us" } };
    config(true);
    await sender.sendTextMsgToChat(chat, "Original");
    assert.equal(requests, 0);
    assert.equal(bodies[0], "Original");
    await activateDraft("333@c.us", "Hello");
    assert.equal(requests, 1);
    await sender.sendTextMsgToChat(chat, "Hello");
    assert.equal(requests, 1);
    assert.equal(bodies[1], "Bonjour\n-----\nHello");
    config(false);
    await activateDraft("333@c.us", "Hello");
    await sender.sendTextMsgToChat(chat, "Hello");
    assert.equal(requests, 2);
    assert.equal(bodies[2], "Bonjour");
    assert.equal(bodies.length, 3);
    await activateDraft("333@c.us", "Hello");
    config(false, false);
    await assert.rejects(sender.sendTextMsgToChat(chat, "Hello"));
    assert.equal(bodies.length, 3);
    assert.equal(requests, 3);
    sessions.close("333@c.us");
    await sender.sendTextMsgToChat(chat, "Hello");
    assert.equal(bodies[3], "Hello");
    assert.equal(requests, 3);
  },
);

const { runIncomingTests } = await import("./incoming-regression");
count += await runIncomingTests();
const { runIncomingDiagnosticsTests } = await import(
  "./incoming-diagnostics-regression"
);
count += await runIncomingDiagnosticsTests();
const { runOutgoingDiagnosticsTests } = await import(
  "./outgoing-diagnostics-regression"
);
count += await runOutgoingDiagnosticsTests();
const { runWorkerTransportTests } = await import(
  "./worker-transport-regression"
);
count += runWorkerTransportTests();
const { runConnectionTestChecks } = await import(
  "./connection-test-regression"
);
count += await runConnectionTestChecks();
const { runIncomingRawIdTests } = await import("./incoming-raw-id-regression");
count += await runIncomingRawIdTests();
const { runErrorsReadinessTests } = await import(
  "./errors-readiness-regression"
);
count += await runErrorsReadinessTests();
const { runIncomingPerformanceTests } = await import("./incoming-performance");
count += await runIncomingPerformanceTests();
const { runDirectionsTests } = await import("./directions-regression");
count += await runDirectionsTests();
const { runPickerTests } = await import("./picker-regression");
count += await runPickerTests();
const { runFloatingLayoutTests } = await import("./floating-layout-regression");
count += runFloatingLayoutTests();
const { runDraftTests } = await import("./draft-regression");
count += await runDraftTests();
const { runManualIncomingTests } = await import("./manual-incoming-regression");
count += await runManualIncomingTests();
const { runRetryTests } = await import("./retry-regression");
count += await runRetryTests();
const { runRenderedMessageTests } = await import(
  "./rendered-message-regression"
);
count += runRenderedMessageTests();
const { runHistoryTests } = await import("./history-regression");
count += await runHistoryTests();
const { runDirectoryHistoryTests } = await import(
  "./directory-history-regression"
);
count += await runDirectoryHistoryTests();
const { runHistoryAccountTests } = await import("./history-account-regression");
count += await runHistoryAccountTests();
const { runUnsavedQueueTests } = await import("./unsaved-history-regression");
count += await runUnsavedQueueTests();
console.log(`${count} regression checks passed`);
