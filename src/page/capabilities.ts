export interface CapabilityState {
  send: boolean;
  incoming: boolean;
  waiting: boolean;
}
let state: CapabilityState = { send: false, incoming: false, waiting: true };
export function getCapabilities(): CapabilityState {
  return state;
}
export function updateCapabilities(next: CapabilityState): void {
  state = next;
  window.dispatchEvent(
    new CustomEvent("wa-translate:capabilities", { detail: next }),
  );
}

let incomingError = "";
export function getIncomingError(): string {
  return incomingError;
}
export function setIncomingError(message: string): void {
  if (incomingError === message) return;
  incomingError = message;
  window.dispatchEvent(new CustomEvent("wa-translate:incoming-status"));
}

export type IncomingStatus =
  | "waiting"
  | "bubble"
  | "decrypting"
  | "skipped"
  | "translated"
  | "failed"
  | "main_missing"
  | "render_unverified"
  | "id_missing"
  | "ambiguous"
  | "invisible"
  | "chat_mismatch"
  | "requesting"
  | "timeout_decrypt"
  | "timeout_bubble"
  | "timeout_request";
const incomingMessages: Record<IncomingStatus, string> = {
  waiting: "等待符合条件的新消息",
  bubble: "等待定位新消息气泡",
  decrypting: "等待新消息解密",
  skipped: "等待超时，已安全跳过",
  translated: "已显示接收译文",
  failed: "接收翻译失败，请展开查看",
  main_missing: "等待聊天主区域（未找到 #main）",
  render_unverified: "仅发现短编号，无法验证渲染聊天，已跳过",
  id_missing: "等待与完整消息编号一致的气泡",
  ambiguous: "发现重复消息气泡，已暂停以免误绑",
  invisible: "消息气泡当前不可见，等待显示",
  chat_mismatch: "消息不属于当前聊天，未请求翻译",
  requesting: "已定位气泡，等待翻译服务返回",
  timeout_decrypt: "等待消息解密超时，已安全跳过",
  timeout_bubble: "等待精确气泡定位超时，未发送翻译请求",
  timeout_request: "翻译请求等待超时，迟到结果将被丢弃",
};
let incomingStatus: IncomingStatus = "waiting";
export function getIncomingStatus(): string {
  return incomingMessages[incomingStatus];
}
export function setIncomingStatus(status: IncomingStatus): void {
  if (status === incomingStatus) return;
  incomingStatus = status;
  window.dispatchEvent(new CustomEvent("wa-translate:incoming-status"));
}

let previewLayout: boolean | null = null;
export function getPreviewLayout(): boolean | null {
  return previewLayout;
}
export function updatePreviewLayout(available: boolean | null): void {
  if (previewLayout === available) return;
  previewLayout = available;
  window.dispatchEvent(
    new CustomEvent("wa-translate:preview-layout", { detail: { available } }),
  );
}
