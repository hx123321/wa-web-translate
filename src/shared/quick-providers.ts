import { configured, type Config, type Provider } from "./types";
export interface QuickChoice {
  id: string;
  label: string;
}
const labels: Record<Provider, string> = {
  anthropic: "Claude",
  openai: "OpenAI",
  google: "Gemini",
  deepseek: "DeepSeek",
  custom: "自定义模型",
};
export function quickChoices(c: Config): QuickChoice[] {
  const llms = (Object.keys(labels) as Provider[])
    .filter((provider) => configured({ ...c, mode: "llm", provider }))
    .map((provider) => ({
      id: `llm:${provider}`,
      label: `大模型 · ${labels[provider]}`,
    }));
  return [
    ...llms,
    { id: "service:google", label: "Google 翻译" },
    { id: "service:microsoft", label: "必应 / Microsoft 翻译" },
  ];
}
export function selectedChoice(c: Config): string {
  return c.mode === "service" ? `service:${c.service}` : `llm:${c.provider}`;
}
