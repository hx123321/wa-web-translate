import type { TranslationOperation } from "./retry";
import { httpError } from "@/shared/errors";
export async function jsonRequest(
  url: string,
  init: RequestInit = {},
  signal?: AbortSignal,
  operation?: TranslationOperation,
): Promise<any> {
  if (operation)
    return operation.run(() => jsonRequest(url, init, operation.signal));
  const timeout = AbortSignal.timeout(20000);
  const res = await fetch(url, {
    ...init,
    credentials: "omit",
    redirect: "error",
    referrerPolicy: "no-referrer",
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!res.ok) throw httpError(res.status);
  const reader = res.body?.getReader();
  if (!reader) throw new Error("Empty response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1048576) throw new Error("Response too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  const text = new TextDecoder().decode(bytes);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Invalid translation response");
  }
}
export function validText(v: unknown): string {
  if (typeof v !== "string" || !v.trim() || v.length > 200000)
    throw new Error("Invalid or empty translation");
  return v;
}
