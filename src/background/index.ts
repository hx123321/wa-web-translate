import { historyAccountForSender } from "./history-account";
import { HistoryRequestGate } from "./history-gate";
import { HistoryBackend } from "./history-backend";
import { testModelConnection } from "./connection-test";
import { customEndpoint } from "@/shared/endpoint";
import { TranslationOperation } from "./retry";
import { TranslationError, safeTranslationError } from "@/shared/errors";
import { configured } from "@/shared/types";
import { TranslationGate } from "./request-gate";
import { translateService } from "./services";
import { loadConfig } from "@/shared/storage";
import type { Config, TranslateRequest, TranslateResult } from "@/shared/types";
import { buildPrompt, parseModelOutput } from "./prompt";
import { callModel } from "./providers";
import type { RpcMessage, TranslateRpcRequest } from "@/shared/messages";

chrome.runtime.onConnect.addListener((port) => {
  if (
    port.name !== "wa-translate" ||
    port.sender?.id !== chrome.runtime.id ||
    !port.sender?.url?.startsWith("https://web.whatsapp.com/")
  )
    return;
  const active = new Map<string, AbortController>();
  const cancelAll = () => {
    for (const c of active.values()) c.abort();
    active.clear();
  };
  const changed = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ) => {
    if (area === "local" && (changes.config || changes.chatLangs)) cancelAll();
  };
  chrome.storage.onChanged.addListener(changed);
  port.onDisconnect.addListener(() => {
    cancelAll();
    chrome.storage.onChanged.removeListener(changed);
  });
  port.onMessage.addListener(async (msg: RpcMessage) => {
    if (!msg || typeof msg.id !== "string" || !msg.id || msg.id.length > 100)
      return;
    if (msg.kind === "TRANSLATE_CANCEL") {
      active.get(msg.id)?.abort();
      active.delete(msg.id);
      return;
    }
    if (msg.kind !== "TRANSLATE_REQUEST" || active.has(msg.id)) return;
    const controller = new AbortController();
    active.set(msg.id, controller);
    let operation: TranslationOperation | undefined;
    try {
      const config = await loadConfig();
      if (!msg.revision || msg.revision !== config.revision)
        throw new TranslationError("cancelled");
      const snapshot = JSON.stringify(config);
      operation = new TranslationOperation(async () => {
        const latest = await loadConfig();
        if (
          !latest.enabled ||
          latest.revision !== msg.revision ||
          JSON.stringify(latest) !== snapshot
        )
          throw new TranslationError("cancelled");
        if (latest.mode === "llm" && latest.provider === "custom") {
          const endpoint = customEndpoint(latest.customBaseUrl);
          if (
            !latest.customCredential ||
            latest.customCredential.endpoint !== endpoint.href ||
            latest.customCredential.key !== latest.apiKeys.custom ||
            !(await chrome.permissions.contains({
              origins: [endpoint.origin + "/*"],
            }))
          )
            throw new TranslationError("authorization");
        }
      }, controller.signal);
      const result = await gate.run(msg.payload, () =>
        performTranslation(msg.payload, config, operation!),
      );
      if (!controller.signal.aborted)
        port.postMessage({
          __waTrans: true,
          kind: "TRANSLATE_RESULT",
          id: msg.id,
          ok: true,
          result,
        } satisfies RpcMessage);
    } catch (error) {
      const failure = safeTranslationError(
        controller.signal.aborted ? new TranslationError("cancelled") : error,
      );
      try {
        port.postMessage({
          __waTrans: true,
          kind: "TRANSLATE_RESULT",
          id: msg.id,
          ok: false,
          error: failure.message,
          code: failure.code,
          status: failure.status,
        } satisfies RpcMessage);
      } catch {}
    } finally {
      operation?.dispose();
      if (active.get(msg.id) === controller) active.delete(msg.id);
    }
  });
});

const gate = new TranslationGate();
async function performTranslation(
  req: TranslateRequest,
  config: Config,
  operation: TranslationOperation,
): Promise<TranslateResult> {
  if (!config.enabled) throw new TranslationError("disabled");
  if (!req.text.trim())
    return { translated: "", source: "unknown", target: req.target };
  if (config.mode === "service")
    return translateService(config.service, req, operation);
  const prompt = buildPrompt(req, config);
  const raw = await callModel(
    config,
    { system: prompt.system, user: prompt.user },
    operation,
  );
  const fallbackSource =
    req.source && req.source !== "auto" ? req.source : "unknown";
  const parsed = parseModelOutput(
    raw,
    prompt.expectsSourcePrefix,
    fallbackSource,
  );
  return {
    translated: parsed.translated,
    source: parsed.source as TranslateResult["source"],
    target: req.target,
  };
}

const history = new HistoryBackend();
const historyGate = new HistoryRequestGate();
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.kind === "TRANSLATION_HISTORY") {
    const options = chrome.runtime.getURL("src/options/index.html");
    if (sender.id !== chrome.runtime.id) return false;
    const isOptions = sender.url?.split(/[?#]/)[0] === options;
    const isWA = sender.url?.startsWith("https://web.whatsapp.com/") === true;
    if (msg.action === "test_directory" && isOptions) {
      void history.testDirectory(msg.locationKey).then(sendResponse);
      return true;
    }
    if (msg.action === "clear" && isOptions) {
      void history.clear(msg.locationKey).then(sendResponse);
      return true;
    }
    if (msg.action === "settings" && isOptions) {
      void history
        .snapshot()
        .then((snapshot) => sendResponse({ status: "ok", ...snapshot }))
        .catch(() => sendResponse({ status: "unavailable" }));
      return true;
    }
    if (msg.action === "configure" && isOptions) {
      void history
        .configure(msg.settings, msg.locationKey, msg.selectionId)
        .then(sendResponse);
      return true;
    }
    if (!isWA) return false;
    if (msg.action === "list") {
      void historyGate
        .run(() => history.list(msg, () => historyAccountForSender(sender)))
        .then(sendResponse);
      return true;
    }
    if (msg.action === "put") {
      void historyGate
        .run(() => history.put(msg, () => historyAccountForSender(sender)))
        .then(sendResponse);
      return true;
    }
    return false;
  }
  if (msg?.kind === "TEST_MODEL_CONNECTION") {
    const optionsUrl = chrome.runtime.getURL("src/options/index.html");
    if (
      sender.id !== chrome.runtime.id ||
      sender.url?.split(/[?#]/)[0] !== optionsUrl
    )
      return false;
    void testModelConnection(loadConfig, callModel).then(sendResponse);
    return true;
  }
  if (msg?.kind === "PING_CONFIG") {
    loadConfig().then((c) => {
      sendResponse({
        provider: c.provider,
        hasKey: configured(c),
        mode: c.mode,
        service: c.service,
        nativeLang: c.nativeLang,
      });
    });
    return true;
  }
  return false;
});
