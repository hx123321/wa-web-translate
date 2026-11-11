import type { Config } from "@/shared/types";
// Exact documented compatibility only. Unknown/custom model names never infer a vendor.
export function thinkingOffFields(c: Config): Record<string, unknown> {
  const model = c.model[c.provider];
  if (
    c.provider === "deepseek" &&
    ["deepseek-flash", "deepseek-v4-pro"].includes(model ?? "")
  )
    return { thinking: { type: "disabled" } };
  if (
    c.provider === "anthropic" &&
    [
      "claude-sonnet-4-6",
      "claude-sonnet-4-5",
      "claude-opus-4-6",
      "claude-opus-4-5",
      "claude-haiku-4-5",
    ].includes(model ?? "")
  )
    return { thinking: { type: "disabled" } };
  if (
    c.provider === "google" &&
    ["gemini-2.5-flash", "gemini-2.5-flash-lite"].includes(model ?? "")
  )
    return { generationConfig: { thinkingConfig: { thinkingBudget: 0 } } };
  if (
    c.provider === "openai" &&
    [
      "gpt-5.1",
      "gpt-5.2",
      "gpt-5.4",
      "gpt-5.5",
      "gpt-5.1-2025-11-13",
      "gpt-5.2-2025-12-11",
      "gpt-5.4-2026-03-05",
    ].includes(model ?? "")
  )
    return { reasoning_effort: "none" };
  if (c.provider === "custom") {
    if (c.customThinking === "thinking_disabled")
      return { thinking: { type: "disabled" } };
    if (c.customThinking === "reasoning_none")
      return { reasoning_effort: "none" };
  }
  return {};
}
