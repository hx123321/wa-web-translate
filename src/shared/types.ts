import { customEndpoint } from "./endpoint";
import type { LanguageCode } from "./languages";

export type Provider =
  | "anthropic"
  | "openai"
  | "google"
  | "deepseek"
  | "custom";

export interface Config {
  revision: string;
  mode: "llm" | "service";
  service: "google" | "microsoft";
  customBaseUrl: string;
  customThinking: "omit" | "thinking_disabled" | "reasoning_none";
  customRevision: string;
  customCredential: { endpoint: string; key: string } | null;
  nativeLang: LanguageCode;
  provider: Provider;
  apiKeys: Partial<Record<Provider, string>>;
  model: Partial<Record<Provider, string>>;
  personality: string;
  sendBoth: boolean;
  enabled: boolean;
}

export const DEFAULT_CONFIG: Config = {
  revision: "legacy",
  mode: "llm",
  service: "google",
  customBaseUrl: "",
  customThinking: "omit",
  customRevision: "",
  customCredential: null,
  nativeLang: "en",
  provider: "anthropic",
  apiKeys: {},
  model: {
    anthropic: "claude-sonnet-4-6",
    openai: "gpt-4o-mini",
    deepseek: "deepseek-flash",
    custom: "",
    google: "gemini-2.0-flash",
  },
  personality:
    "Translate naturally and idiomatically. Match the tone of the original message (casual chat stays casual, formal stays formal). Preserve emojis. Do not add explanations.",
  sendBoth: false,
  enabled: true,
};

export interface ChatDirections {
  incoming: LanguageCode | null;
  outgoing: LanguageCode | null;
}

export interface ChatLangMap {
  [chatId: string]: LanguageCode | ChatDirections;
}

export interface TranslateRequest {
  text: string;
  source?: LanguageCode | "auto";
  target: LanguageCode;
}

export interface TranslateResult {
  translated: string;
  source: LanguageCode | "unknown";
  target: LanguageCode;
}

// An explicit allowlist, never a spread of the private configuration.
export type PublicConfig = Pick<
  Config,
  | "nativeLang"
  | "enabled"
  | "sendBoth"
  | "mode"
  | "provider"
  | "service"
  | "revision"
>;
export function publicConfig(c: Config): PublicConfig {
  return {
    revision: c.revision,
    nativeLang: c.nativeLang,
    enabled: c.enabled,
    sendBoth: c.sendBoth,
    mode: c.mode,
    provider: c.provider,
    service: c.service,
  };
}
export function configured(c: Config): boolean {
  if (c.mode === "service") return true;
  if (!c.model[c.provider]?.trim()) return false;
  if (c.provider !== "custom") return !!c.apiKeys[c.provider]?.trim();
  try {
    return (
      !!c.customCredential?.key &&
      c.customCredential.endpoint === customEndpoint(c.customBaseUrl).href &&
      c.customCredential.key === c.apiKeys.custom
    );
  } catch {
    return false;
  }
}
