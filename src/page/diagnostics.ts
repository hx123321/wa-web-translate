import {
  getStorageDiagnostics,
  clearStorageDiagnostics,
} from "./storage-diagnostics";
import {
  getOutgoingDiagnostics,
  getOutgoingDiagnosticLabel,
  clearOutgoingDiagnostics,
} from "./outgoing-diagnostics";
const stages = [
  "observed",
  "rejected",
  "rejected_identity",
  "rejected_not_new",
  "rejected_outgoing",
  "rejected_disabled",
  "rejected_type",
  "rejected_body",
  "duplicate",
  "queued",
  "manual",
  "decrypting",
  "main_missing",
  "render_unverified",
  "id_missing",
  "ambiguous",
  "invisible",
  "chat_mismatch",
  "bubble_ready",
  "requesting",
  "translated",
  "failed",
  "retry",
  "failed_network",
  "failed_bridge",
  "failed_timeout",
  "failed_http",
  "failed_authorization",
  "failed_rate_limit",
  "failed_response",
  "failed_configuration",
  "failed_request",
  "failed_disabled",
  "failed_cancelled",
  "failed_unknown",
  "timeout_decrypt",
  "timeout_bubble",
  "timeout_request",
  "expired",
  "invalidated",
] as const;
export type IncomingDiagnosticStage = (typeof stages)[number];
export interface IncomingDiagnostic {
  stage: IncomingDiagnosticStage;
  time: number;
  count: number;
}
const allowed = new Set<string>(stages);
const records: IncomingDiagnostic[] = [];
let notificationQueued = false;
function notify(): void {
  if (notificationQueued) return;
  notificationQueued = true;
  queueMicrotask(() => {
    notificationQueued = false;
    window.dispatchEvent(new CustomEvent("wa-translate:incoming-status"));
  });
}
// Never store arbitrary context, error objects, IDs, URLs or message content.
export function recordIncomingDiagnostic(
  stage: IncomingDiagnosticStage,
  count = 1,
): void {
  if (typeof stage !== "string" || !allowed.has(stage)) return;
  const safeCount =
    typeof count === "number" && Number.isFinite(count)
      ? Math.max(1, Math.min(1000000, Math.floor(count)))
      : 1;
  const now = Date.now();
  records.push({
    stage,
    time: Number.isFinite(now) ? Math.max(0, Math.floor(now)) : 0,
    count: safeCount,
  });
  if (records.length > 80) records.splice(0, records.length - 80);
  notify();
}
export function getIncomingDiagnostics(): IncomingDiagnostic[] {
  return records.map(({ stage, time, count }) => ({ stage, time, count }));
}
export function clearIncomingDiagnostics(): void {
  if (!records.length) return;
  records.length = 0;
  notify();
}

const labels: Record<IncomingDiagnosticStage, string> = {
  observed: "收到消息事件",
  rejected: "已安全拒绝",
  rejected_identity: "消息身份无法验证",
  rejected_not_new: "不是新消息事件",
  rejected_outgoing: "不是入站消息",
  rejected_disabled: "未开启接收翻译",
  rejected_type: "不是支持的纯文本消息",
  rejected_body: "正文为空、类型无效或超过长度限制",
  duplicate: "已处理的重复事件",
  queued: "进入待处理队列",
  manual: "手动选中单条消息",
  decrypting: "等待消息解密",
  main_missing: "未找到聊天主区域",
  render_unverified: "仅发现短编号，无法验证渲染聊天，已跳过",
  id_missing: "没有完整编号相同的气泡",
  ambiguous: "多个可见气泡编号相同",
  invisible: "编号匹配但气泡不可见",
  chat_mismatch: "消息不属于当前聊天",
  bubble_ready: "已定位唯一可见气泡",
  requesting: "等待翻译服务返回",
  translated: "译文已就绪",
  failed: "翻译请求失败",
  failed_bridge: "扩展连接失效，请重新加载扩展和页面",
  failed_network: "服务连接失败",
  failed_timeout: "服务请求超时",
  failed_http: "服务返回HTTP错误",
  failed_authorization: "服务授权失败",
  failed_rate_limit: "服务限流或请求过多",
  failed_response: "服务响应格式无效",
  failed_configuration: "服务配置无效",
  failed_request: "请求参数无效",
  failed_disabled: "翻译已关闭",
  failed_cancelled: "翻译请求已取消",
  failed_unknown: "未分类的安全错误",
  retry: "用户手动重试",
  timeout_decrypt: "等待解密超时",
  timeout_bubble: "等待定位气泡超时",
  timeout_request: "等待请求返回超时",
  expired: "旁注保留时间结束",
  invalidated: "配置、聊天或内容改变，旧任务失效",
};
export function getIncomingDiagnosticLabel(
  stage: IncomingDiagnosticStage,
): string {
  return Object.hasOwn(labels, stage) ? labels[stage] : "未知阶段";
}

// Only closed-schema snapshots are serialized. No configuration or message state.
export function exportTranslationDiagnostics(): string {
  const incoming = getIncomingDiagnostics().map((row) => ({
    ...row,
    direction: "接收",
    label: getIncomingDiagnosticLabel(row.stage),
  }));
  const outgoing = getOutgoingDiagnostics().map((row) => ({
    ...row,
    direction: "发送",
    label: getOutgoingDiagnosticLabel(row.stage),
  }));
  const rows = [...incoming, ...outgoing].sort((a, b) => a.time - b.time);
  return [
    "WA翻译阶段日志（仅内存；不含正文、联系人、消息编号、密钥或地址）",
    "阶段说明：请求开始不代表服务收到；WhatsApp接口成功不代表收件人送达；未记录不可见的后台自动重试。",
    ...getStorageDiagnostics(),
    ...rows.map(
      (row) =>
        `${row.time} [${row.direction}] ${row.stage} · ${row.label} ×${row.count}`,
    ),
  ].join("\n");
}
export function clearTranslationDiagnostics(): void {
  clearStorageDiagnostics();
  clearIncomingDiagnostics();
  clearOutgoingDiagnostics();
}
