import { thinkingOffFields } from "./thinking";
import type { TranslationOperation } from "./retry";
import { loadConfig } from "@/shared/storage";
import type { Config } from "@/shared/types";
import { customEndpoint } from "@/shared/endpoint";
import { jsonRequest, validText } from "./http";
export interface CallArgs {
  system: string;
  user: string;
}
export async function callModel(
  c: Config,
  args: CallArgs,
  operation?: TranslationOperation,
): Promise<string> {
  if (
    !["anthropic", "openai", "google", "deepseek", "custom"].includes(
      c.provider,
    )
  )
    throw new Error("Invalid provider.");
  const key =
    c.provider === "custom" ? c.customCredential?.key : c.apiKeys[c.provider];
  if (
    c.provider === "custom" &&
    (!c.customCredential ||
      c.customCredential.endpoint !== customEndpoint(c.customBaseUrl).href ||
      key !== c.apiKeys.custom)
  )
    throw new Error(
      "Explicitly approve this endpoint and key in settings first.",
    );
  if (!key) throw new Error("Configure an API key for the selected provider.");
  const model = c.model[c.provider];
  if (!model?.trim()) throw new Error("Configure a model.");
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  let url: string, body: unknown;
  if (c.provider === "anthropic") {
    url = "https://api.anthropic.com/v1/messages";
    Object.assign(headers, {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    });
    body = {
      model,
      max_tokens: 4096,
      system: args.system,
      messages: [{ role: "user", content: args.user }],
    };
  } else if (c.provider === "google") {
    url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    headers["x-goog-api-key"] = key;
    body = {
      systemInstruction: { parts: [{ text: args.system }] },
      contents: [{ role: "user", parts: [{ text: args.user }] }],
    };
  } else {
    if (c.provider === "custom") {
      const endpoint = customEndpoint(c.customBaseUrl);
      if (
        !(await chrome.permissions.contains({
          origins: [endpoint.origin + "/*"],
        }))
      )
        throw new Error("Allow the custom endpoint in settings first.");
      const latest = await loadConfig();
      if (
        latest.customRevision !== c.customRevision ||
        latest.customCredential?.endpoint !== endpoint.href ||
        latest.customCredential?.key !== key ||
        latest.apiKeys.custom !== key ||
        customEndpoint(latest.customBaseUrl).href !== endpoint.href
      )
        throw new Error("Custom configuration changed; approve it again.");
      url = endpoint.href;
    } else
      url =
        c.provider === "deepseek"
          ? "https://api.deepseek.com/chat/completions"
          : "https://api.openai.com/v1/chat/completions";
    headers.authorization = `Bearer ${key}`;
    body = {
      model,
      messages: [
        { role: "system", content: args.system },
        { role: "user", content: args.user },
      ],
      temperature: 0.2,
    };
  }
  body = { ...(body as Record<string, unknown>), ...thinkingOffFields(c) };
  const data = await jsonRequest(
    url,
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    },
    undefined,
    operation,
  );
  return validText(
    c.provider === "anthropic"
      ? Array.isArray(data?.content)
        ? data.content.find((x: any) => x?.type === "text")?.text
        : undefined
      : c.provider === "google"
        ? Array.isArray(data?.candidates?.[0]?.content?.parts)
          ? data.candidates[0].content.parts
              .map((x: any) => (typeof x?.text === "string" ? x.text : ""))
              .join("")
          : undefined
        : data?.choices?.[0]?.message?.content,
  );
}
