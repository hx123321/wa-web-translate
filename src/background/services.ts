import type { TranslationOperation } from "./retry";
import { httpError } from "@/shared/errors";
import { getLanguage } from "@/shared/languages";
// Endpoint and chunking approach reused from VantreLingo FreeTranslators.cs.
import type { TranslateRequest, TranslateResult } from "@/shared/types";
import { jsonRequest, validText } from "./http";
export function chunks(text: string): string[] {
  const result: string[] = [];
  while (text) {
    let length = Math.min(1000, text.length);
    if (length < text.length && /[\uD800-\uDBFF]/.test(text[length - 1]))
      length--;
    result.push(text.slice(0, length));
    text = text.slice(length);
  }
  return result;
}
export function microsoftCode(s: string): string {
  const codes: Record<string, string> = {
    "zh-CN": "zh-Hans",
    "zh-TW": "zh-Hant",
    tl: "fil",
    no: "nb",
  };
  return codes[s] ?? s;
}
export function internalCode(s: string): string {
  const codes: Record<string, string> = {
    "zh-Hans": "zh-CN",
    "zh-Hant": "zh-TW",
    fil: "tl",
    nb: "no",
  };
  return codes[s] ?? s;
}

let token: string | undefined;
let expires = 0;
async function getToken(operation?: TranslationOperation): Promise<string> {
  if (token && expires > Date.now()) return token;
  const request = async () => {
    const res = await fetch("https://edge.microsoft.com/translate/auth", {
      credentials: "omit",
      redirect: "error",
      signal: operation
        ? AbortSignal.any([operation.signal, AbortSignal.timeout(10000)])
        : AbortSignal.timeout(10000),
    });
    if (!res.ok) throw httpError(res.status);
    // Edge auth is bounded to a small token response.
    const reader = res.body?.getReader();
    if (!reader) throw new Error("Empty authorization response");
    let raw = "";
    const decoder = new TextDecoder();
    try {
      while (true) {
        const r = await reader.read();
        if (r.done) break;
        raw += decoder.decode(r.value, { stream: true });
        if (raw.length > 16384)
          throw new Error("Invalid authorization response");
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const value = raw.trim().replace(/^"|"$/g, "");
    if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(value))
      throw new Error("Invalid Microsoft authorization response");
    token = value;
    expires = Date.now() + 180000;
    return value;
  };
  return operation ? operation.run(request) : request();
}
export async function translateService(
  service: "google" | "microsoft",
  req: TranslateRequest,
  operation?: TranslationOperation,
): Promise<TranslateResult> {
  const signal = AbortSignal.timeout(25000);
  let translated = "";
  let source = req.source === "auto" ? "unknown" : (req.source ?? "unknown");
  for (const text of chunks(req.text)) {
    if (service === "google") {
      const q = new URLSearchParams({
        client: "gtx",
        sl: req.source ?? "auto",
        tl: req.target,
        dt: "t",
        q: text,
      });
      const d = await jsonRequest(
        "https://translate.google.com/translate_a/single?" + q,
        {},
        signal,
        operation,
      );
      if (!Array.isArray(d?.[0])) throw new Error("Invalid Google response");
      translated += d[0]
        .map((segment: unknown) => {
          if (!Array.isArray(segment) || typeof segment[0] !== "string")
            throw new Error("Invalid Google response");
          return segment[0];
        })
        .join("");
      if (typeof d[2] === "string") source = d[2];
    } else {
      const q = new URLSearchParams({
        "api-version": "3.0",
        to: microsoftCode(req.target),
      });
      if (req.source && req.source !== "auto")
        q.set("from", microsoftCode(req.source));
      const auth = await getToken(operation);
      const d = await jsonRequest(
        "https://api-edge.cognitive.microsofttranslator.com/translate?" + q,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer " + auth,
          },
          body: JSON.stringify([{ Text: text }]),
        },
        signal,
        operation,
      ).catch((e) => {
        token = undefined;
        throw e;
      });
      translated += validText(d?.[0]?.translations?.[0]?.text);
      if (d?.[0]?.detectedLanguage?.language)
        source = d[0].detectedLanguage.language;
    }
  }
  source = internalCode(source);
  if (!getLanguage(source)) source = "unknown";
  return { translated: validText(translated), source, target: req.target };
}
