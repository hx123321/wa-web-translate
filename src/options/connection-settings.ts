import type { Config, Provider } from "@/shared/types";
export const BUILTIN_CONNECTIONS: Record<
  Exclude<Provider, "custom">,
  string
> = {
  deepseek: "https://api.deepseek.com/chat/completions",
  openai: "https://api.openai.com/v1/chat/completions",
  anthropic: "https://api.anthropic.com/v1/messages",
  google: "https://generativelanguage.googleapis.com/v1beta",
};
// A connection edit is a new explicit credential destination, never a key copy.
export function editableConnection(config: Config): Partial<Config> {
  return {
    mode: "llm",
    customThinking:
      config.provider === "deepseek" ? "thinking_disabled" : "omit",
    provider: "custom",
    customBaseUrl:
      config.provider === "deepseek"
        ? "https://api.deepseek.com"
        : config.provider === "openai"
          ? "https://api.openai.com/v1"
          : "",
    model: {
      custom:
        config.provider === "deepseek" || config.provider === "openai"
          ? (config.model[config.provider] ?? "")
          : "",
    },
    apiKeys: { custom: "" },
    customCredential: null,
  };
}
