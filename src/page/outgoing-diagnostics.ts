import { safeTranslationError } from "@/shared/errors";
const labels = {
  activated: "主动触发草稿翻译",
  manual_retry: "手动重试草稿翻译",
  eligible: "草稿满足本地翻译条件",
  rejected_disabled: "翻译未开启",
  rejected_target: "未选择发送目标语言",
  rejected_body: "草稿为空",
  request_started: "已调用翻译通道（不代表服务已接收）",
  response_received: "翻译通道已返回结果",
  preview_ready: "译文已写入预览状态",
  preview_shown: "已启用草稿预览显示",
  preview_hidden: "已隐藏草稿预览",
  cancelled: "已取消待处理翻译",
  invalidated: "草稿或设置变化，旧译文失效",
  stale_discarded: "已丢弃过期响应",
  closed: "已关闭草稿翻译",
  disposed: "已清理草稿会话",
  send_triggered: "WhatsApp发送接口被调用",
  send_identity_unknown: "无法确认发送聊天身份，未改写正文",
  send_body_unsupported: "不是可翻译的文本发送参数",
  send_original: "未改写，沿用普通发送",
  send_translation_ready: "采用匹配的有效译文",
  send_blocked: "无匹配有效译文，已阻止发送",
  wa_send_started: "已调用原WhatsApp发送接口",
  wa_send_resolved: "WhatsApp发送接口返回成功（未核实送达）",
  wa_send_failed: "WhatsApp发送接口返回失败（未自动重试）",
  failed_bridge: "扩展与后台连接失效，请重载扩展并刷新页面",
  failed_network: "翻译连接失败",
  failed_timeout: "翻译请求超时",
  failed_http: "翻译服务返回HTTP错误",
  failed_authorization: "翻译授权失败",
  failed_rate_limit: "翻译请求受限",
  failed_response: "翻译响应格式无效",
  failed_configuration: "翻译配置无效",
  failed_request: "翻译请求参数无效",
  failed_disabled: "翻译已关闭",
  failed_cancelled: "翻译通道已取消请求",
  failed_unknown: "未分类的安全翻译错误",
} as const;
export type OutgoingDiagnosticStage = keyof typeof labels;
export interface OutgoingDiagnostic {
  stage: OutgoingDiagnosticStage;
  time: number;
  count: number;
}
const records: OutgoingDiagnostic[] = [];
let queued = false;
function notify(): void {
  if (queued) return;
  queued = true;
  queueMicrotask(() => {
    queued = false;
    window.dispatchEvent(new CustomEvent("wa-translate:incoming-status"));
  });
}
export function recordOutgoingDiagnostic(
  stage: OutgoingDiagnosticStage,
  count = 1,
): void {
  if (typeof stage !== "string" || !Object.hasOwn(labels, stage)) return;
  const now = Date.now();
  records.push({
    stage,
    time: Number.isFinite(now) ? Math.max(0, Math.floor(now)) : 0,
    count:
      typeof count === "number" && Number.isFinite(count)
        ? Math.max(1, Math.min(1000000, Math.floor(count)))
        : 1,
  });
  if (records.length > 80) records.splice(0, records.length - 80);
  notify();
}
export function outgoingFailureStage(error: unknown): OutgoingDiagnosticStage {
  const stage = `failed_${safeTranslationError(error).code}`;
  return Object.hasOwn(labels, stage)
    ? (stage as OutgoingDiagnosticStage)
    : "failed_unknown";
}
export function getOutgoingDiagnosticLabel(
  stage: OutgoingDiagnosticStage,
): string {
  return Object.hasOwn(labels, stage) ? labels[stage] : "未知阶段";
}
export function getOutgoingDiagnostics(): OutgoingDiagnostic[] {
  return records.map(({ stage, time, count }) => ({ stage, time, count }));
}
export function clearOutgoingDiagnostics(): void {
  if (!records.length) return;
  records.length = 0;
  notify();
}
