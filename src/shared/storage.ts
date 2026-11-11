import {
  directions,
  normalizeDirections,
  validChatId,
  type Direction,
} from "./chat-directions";
import { getLanguage } from "./languages";
import { quickChoices } from "./quick-providers";
import { customEndpoint } from "./endpoint";
import { DEFAULT_CONFIG, type ChatLangMap, type Config } from "./types";

const KEY_CONFIG = "config";
const KEY_CHAT_LANGS = "chatLangs";
const KEY_INBOUND_CACHE = "inboundCache";

export async function loadConfig(): Promise<Config> {
  const got = await chrome.storage.local.get(KEY_CONFIG);
  const stored = (got[KEY_CONFIG] ?? {}) as Partial<Config>;
  if (
    stored.provider !== undefined &&
    !["anthropic", "openai", "google", "deepseek", "custom"].includes(
      stored.provider,
    )
  )
    throw new Error(
      "Invalid provider configuration. Reset the extension settings.",
    );
  if (stored.mode !== undefined && !["llm", "service"].includes(stored.mode))
    throw new Error("Invalid translation mode.");
  if (
    stored.service !== undefined &&
    !["google", "microsoft"].includes(stored.service)
  )
    throw new Error("Invalid translation service.");
  if (
    stored.customThinking !== undefined &&
    !["omit", "thinking_disabled", "reasoning_none"].includes(
      stored.customThinking,
    )
  )
    throw new Error(
      "Invalid provider configuration. Reset the extension settings.",
    );
  const config: Config = {
    ...DEFAULT_CONFIG,
    ...stored,
    apiKeys: { ...DEFAULT_CONFIG.apiKeys, ...(stored.apiKeys ?? {}) },
    model: { ...DEFAULT_CONFIG.model, ...(stored.model ?? {}) },
  };
  // Legacy custom keys are never approved or used automatically.
  if (!stored.customRevision) {
    config.customRevision = "";
    config.customCredential = null;
    delete config.apiKeys.custom;
  }
  if (config.customCredential) {
    try {
      if (
        typeof config.customCredential.key !== "string" ||
        !config.customCredential.key ||
        config.customCredential.key !== config.apiKeys.custom ||
        config.customCredential.endpoint !==
          customEndpoint(config.customBaseUrl).href
      )
        config.customCredential = null;
    } catch {
      config.customCredential = null;
    }
  }
  return config;
}

let saves: Promise<unknown> = Promise.resolve();
export function saveConfig(patch: Partial<Config>): Promise<Config> {
  const next = saves.then(() => applyConfig(patch));
  saves = next.catch(() => {});
  return next;
}
async function applyConfig(patch: Partial<Config>): Promise<Config> {
  const current = await loadConfig();
  if (
    patch.customThinking !== undefined &&
    !["omit", "thinking_disabled", "reasoning_none"].includes(
      patch.customThinking,
    )
  )
    throw new Error(
      "Invalid provider configuration. Reset the extension settings.",
    );
  if (patch.nativeLang !== undefined) await loadChatLangs();
  const next = {
    ...current,
    ...patch,
    apiKeys: { ...current.apiKeys, ...patch.apiKeys },
    model: { ...current.model, ...patch.model },
  };
  // Ordinary saves cannot manufacture an approval, including via a forged patch.
  next.customCredential = current.customCredential;
  next.customRevision = current.customRevision;
  const endpointEdited = Object.hasOwn(patch, "customBaseUrl");
  const keyEdited = !!patch.apiKeys && Object.hasOwn(patch.apiKeys, "custom");
  if (endpointEdited || keyEdited) {
    next.customCredential = null;
    next.customRevision = crypto.randomUUID();
    if (endpointEdited) delete next.apiKeys.custom;
  }
  next.revision = crypto.randomUUID();
  await chrome.storage.local.set({ [KEY_CONFIG]: next });
  return next;
}

// Called only by the extension options page after an explicit approval click.
// Expected revision also detects edits from other extension pages while permission was pending.
export function approveCustomCredential(
  expected: Pick<Config, "customBaseUrl" | "customRevision"> & { key: string },
): Promise<Config> {
  const next = saves.then(async () => {
    const current = await loadConfig();
    if (
      !expected.customRevision ||
      current.customRevision !== expected.customRevision ||
      current.customBaseUrl !== expected.customBaseUrl ||
      !expected.key ||
      current.apiKeys.custom !== expected.key
    )
      throw new Error(
        "Custom configuration changed. Review and approve again.",
      );
    const endpoint = customEndpoint(current.customBaseUrl);
    if (
      !(await chrome.permissions.contains({
        origins: [endpoint.origin + "/*"],
      }))
    )
      throw new Error("Endpoint permission was not granted.");
    // Re-read after the asynchronous permission check, before recording the approval.
    const latest = await loadConfig();
    if (
      latest.customRevision !== expected.customRevision ||
      latest.customBaseUrl !== expected.customBaseUrl ||
      latest.apiKeys.custom !== expected.key
    )
      throw new Error("Custom configuration changed.");
    latest.customCredential = { endpoint: endpoint.href, key: expected.key };
    latest.revision = crypto.randomUUID();
    await chrome.storage.local.set({ [KEY_CONFIG]: latest });
    return latest;
  });
  saves = next.catch(() => {});
  return next;
}

export function selectTranslationChoice(choice: string): Promise<Config> {
  const next = saves.then(async () => {
    let current = await loadConfig();
    if (!quickChoices(current).some((c) => c.id === choice))
      throw new Error("Provider is not configured. Open settings first.");
    if (choice === "llm:custom") {
      const endpoint = customEndpoint(current.customBaseUrl);
      const revision = current.customRevision;
      if (
        !(await chrome.permissions.contains({
          origins: [endpoint.origin + "/*"],
        }))
      )
        throw new Error("Custom endpoint permission is missing.");
      current = await loadConfig();
      if (
        current.customRevision !== revision ||
        !quickChoices(current).some((c) => c.id === choice)
      )
        throw new Error("Custom approval changed. Open settings.");
    }
    const [mode, provider] = choice.split(":");
    const updated: Config =
      mode === "service"
        ? {
            ...current,
            mode: "service",
            service: provider as Config["service"],
          }
        : { ...current, mode: "llm", provider: provider as Config["provider"] };
    updated.revision = crypto.randomUUID();
    await chrome.storage.local.set({ [KEY_CONFIG]: updated });
    return updated;
  });
  saves = next.catch(() => {});
  return next;
}

let chatSaves: Promise<unknown> = Promise.resolve();
async function readAndMigrateChatLangs(): Promise<ChatLangMap> {
  const got = await chrome.storage.local.get(KEY_CHAT_LANGS);
  const config = await loadConfig();
  const normalized = normalizeDirections(
    got[KEY_CHAT_LANGS],
    config.nativeLang,
  );
  if (
    Object.values(got[KEY_CHAT_LANGS] ?? {}).some((v) => typeof v === "string")
  )
    await chrome.storage.local.set({ [KEY_CHAT_LANGS]: normalized });
  return normalized;
}
export function loadChatLangs(): Promise<ChatLangMap> {
  const next = chatSaves.then(readAndMigrateChatLangs);
  chatSaves = next.catch(() => {});
  return next;
}
export function setChatLang(
  chatId: string,
  lang: string | null,
  direction: Direction = "outgoing",
): Promise<void> {
  if (
    !validChatId(chatId) ||
    (lang !== null && !getLanguage(lang)) ||
    !["incoming", "outgoing"].includes(direction)
  )
    return Promise.reject(new Error("Invalid chat setting"));
  const next = chatSaves.then(async () => {
    const map = await readAndMigrateChatLangs();
    const config = await loadConfig();
    map[chatId] = {
      ...directions(map[chatId], config.nativeLang),
      [direction]: lang,
    };
    await chrome.storage.local.set({ [KEY_CHAT_LANGS]: map });
  });
  chatSaves = next.catch(() => {});
  return next;
}

export async function getInboundCache(): Promise<Record<string, string>> {
  const got = await chrome.storage.local.get(KEY_INBOUND_CACHE);
  return (got[KEY_INBOUND_CACHE] ?? {}) as Record<string, string>;
}

export async function cacheInbound(
  messageId: string,
  translated: string,
): Promise<void> {
  const cache = await getInboundCache();
  cache[messageId] = translated;
  // Cap to 5000 entries
  const keys = Object.keys(cache);
  if (keys.length > 5000) {
    for (const k of keys.slice(0, keys.length - 5000)) delete cache[k];
  }
  await chrome.storage.local.set({ [KEY_INBOUND_CACHE]: cache });
}

export function watchConfig(cb: (cfg: Config) => void): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ) => {
    if (area !== "local" || !changes[KEY_CONFIG]) return;
    loadConfig().then(cb);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

export function watchChatLangs(cb: (map: ChatLangMap) => void): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ) => {
    if (area !== "local" || !changes[KEY_CHAT_LANGS]) return;
    loadChatLangs().then(cb);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
