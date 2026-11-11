export type TranslationErrorCode =
  | "network"
  | "bridge"
  | "timeout"
  | "http"
  | "rate_limit"
  | "authorization"
  | "response"
  | "configuration"
  | "request"
  | "disabled"
  | "unknown"
  | "cancelled";

const messages: Record<TranslationErrorCode, string> = {
  bridge: "扩展连接已失效，请重新加载扩展后刷新 WhatsApp 页面，再手动重试。",
  network: "无法连接翻译服务，请检查网络或稍后重试。",
  timeout: "翻译服务响应超时，请稍后重试。",
  http: "翻译服务暂时不可用，请稍后重试。",
  rate_limit: "翻译请求过于频繁，请稍候再试。",
  authorization: "翻译服务授权失败，请检查密钥或自定义地址授权。",
  response: "翻译服务返回了无法识别的内容，请稍后重试或切换服务。",
  configuration: "翻译服务配置不完整，请检查所选服务、模型和密钥。",
  request: "翻译内容或语言无效，单次最多支持5000个字符。",
  disabled: "翻译已关闭。",
  unknown: "翻译失败，请检查设置后重试。",
  cancelled: "翻译已取消，请按当前设置重新操作。",
};
export class TranslationError extends Error {
  constructor(
    public readonly code: TranslationErrorCode,
    public readonly status?: number,
  ) {
    super(
      messages[code] +
        (Number.isInteger(status) && status! >= 100 && status! <= 599
          ? `（HTTP ${status}）`
          : ""),
    );
    this.name = "TranslationError";
  }
}
export function httpError(status: number): TranslationError {
  return new TranslationError(
    status === 429
      ? "rate_limit"
      : status === 401 || status === 403
        ? "authorization"
        : "http",
    status,
  );
}
// Only known local messages are classified. Never return an arbitrary exception,
// response body, URL or key to the page or the console.
export function safeTranslationError(error: unknown): {
  code: TranslationErrorCode;
  message: string;
  status?: number;
} {
  let code: TranslationErrorCode = "unknown";
  let status: number | undefined;
  if (error instanceof TranslationError) {
    code = error.code;
    status = error.status;
  } else if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError")
      code = "timeout";
    else if (
      error.message === "Failed to fetch" ||
      error.message === "fetch failed" ||
      error.message === "NetworkError when attempting to fetch resource."
    )
      code = "network";
    else if (error.message === "Translation busy. Please retry shortly.")
      code = "rate_limit";
    else if (
      error.message === "Invalid translation request (maximum 5000 characters)."
    )
      code = "request";
    else if (error.message === "Translation disabled.") code = "disabled";
    else if (
      [
        "Explicitly approve this endpoint and key in settings first.",
        "Allow the custom endpoint in settings first.",
        "Custom configuration changed; approve it again.",
      ].includes(error.message)
    )
      code = "authorization";
    else if (
      [
        "Configure an API key for the selected provider.",
        "Configure a model.",
        "Invalid provider.",
        "Invalid provider configuration. Reset the extension settings.",
        "Invalid translation mode.",
        "Invalid translation service.",
      ].includes(error.message)
    )
      code = "configuration";
    else if (
      [
        "Invalid Google response",
        "Empty authorization response",
        "Invalid authorization response",
        "Invalid Microsoft authorization response",
        "Empty response",
        "Response too large",
        "Invalid translation response",
        "Invalid or empty translation",
      ].includes(error.message)
    )
      code = "response";
  }
  if (!Number.isInteger(status) || status! < 100 || status! > 599)
    status = undefined;
  return {
    code,
    message: messages[code] + (status ? `（HTTP ${status}）` : ""),
    ...(status ? { status } : {}),
  };
}

export function receivedTranslationError(
  code: unknown,
  status?: unknown,
): TranslationError {
  const valid =
    typeof code === "string" && Object.hasOwn(messages, code)
      ? (code as TranslationErrorCode)
      : "unknown";
  return new TranslationError(
    valid,
    typeof status === "number" &&
    Number.isInteger(status) &&
    status >= 100 &&
    status <= 599
      ? status
      : undefined,
  );
}
