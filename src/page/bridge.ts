import { receivedTranslationError, TranslationError } from "@/shared/errors";
import {
  newRpcId,
  TAG,
  type RpcMessage,
  type TranslateRpcRequest,
} from "@/shared/messages";
import type { TranslateRequest, TranslateResult } from "@/shared/types";
import { getConfig, subscribe } from "./store";

interface Pending {
  resolve(r: TranslateResult): void;
  reject(e: Error): void;
  cancel(): void;
}
const pending = new Map<string, Pending>();
export function cancelPendingTranslations(): void {
  for (const request of [...pending.values()]) request.cancel();
}
subscribe("config", cancelPendingTranslations);
subscribe("chatLangs", cancelPendingTranslations);
window.addEventListener("pagehide", cancelPendingTranslations);
window.addEventListener("message", (e) => {
  if (e.source !== window) return;
  const data = e.data as RpcMessage | undefined;
  if (
    !data ||
    (data as unknown as Record<string, unknown>)[TAG] !== true ||
    data.kind !== "TRANSLATE_RESULT"
  )
    return;
  const p = pending.get(data.id);
  if (!p) return;
  if (data.ok) p.resolve(data.result);
  else p.reject(receivedTranslationError(data.code, data.status));
});

export function translate(
  req: TranslateRequest,
  timeoutMs = 30000,
  signal?: AbortSignal,
): Promise<TranslateResult> {
  if (signal?.aborted) return Promise.reject(new TranslationError("cancelled"));
  const id = newRpcId();
  const msg: TranslateRpcRequest = {
    __waTrans: true,
    kind: "TRANSLATE_REQUEST",
    id,
    payload: req,
    revision: getConfig().revision,
  };
  return new Promise((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      pending.delete(id);
      signal?.removeEventListener("abort", cancel);
    };
    const abort = (code: "cancelled" | "timeout") => {
      if (!pending.has(id)) return;
      finish();
      window.postMessage(
        { __waTrans: true, kind: "TRANSLATE_CANCEL", id },
        "*",
      );
      reject(new TranslationError(code));
    };
    const cancel = () => abort("cancelled");
    const timer = setTimeout(() => abort("timeout"), timeoutMs);
    pending.set(id, {
      resolve: (value) => {
        finish();
        resolve(value);
      },
      reject: (error) => {
        finish();
        reject(error);
      },
      cancel,
    });
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) {
      cancel();
      return;
    }
    window.postMessage(msg, "*");
  });
}
