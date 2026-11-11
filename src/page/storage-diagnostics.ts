export type StoragePhase = "probe" | "write" | "retry";
const labels: Record<string, string> = {
  ok: "成功",
  permission: "目录读写权限未生效，请在设置重新授权",
  account: "当前页面账号无法核验，已停止读写",
  conflict: "保存位置已变化，未向新位置迁移",
  full: "保存容量不足",
  corrupt: "目录归属或记录格式校验失败，未知文件未改动",
  invalid: "记录或保存参数未通过校验",
  busy: "扩展存储请求繁忙，等待下一次重试",
  timeout: "扩展保存响应超时，尚未确认写入",
  unavailable: "本地存储或扩展连接不可用",
  superseded: "已有更新记录，旧暂存不再写入",
};
const stages: Record<string, string> = {
  validate: "记录校验",
  root: "保存根目录",
  folders: "日期会话目录",
  existing: "现有记录读取",
  owner_open: "归属标记打开",
  owner_writer: "归属标记写入器",
  owner_write: "归属标记写入",
  owner_close: "归属标记提交",
  record_open: "译文文件打开",
  record_writer: "译文文件写入器",
  record_write: "译文内容写入",
  record_close: "译文文件提交",
  cleanup: "容量清理",
};
const errors = new Set([
  "NotAllowedError",
  "SecurityError",
  "QuotaExceededError",
  "NotFoundError",
  "InvalidStateError",
  "NoModificationAllowedError",
  "NotReadableError",
  "TypeMismatchError",
  "AbortError",
  "TypeError",
  "unknown",
]);
function safeDetail(result: unknown): string {
  const v = (
    result as { failure?: { stage?: unknown; error?: unknown } } | null
  )?.failure;
  if (!v || typeof v.stage !== "string" || !Object.hasOwn(stages, v.stage))
    return "";
  const error =
    typeof v.error === "string" && errors.has(v.error) ? v.error : "unknown";
  return " [" + v.stage + "/" + error + "：" + stages[v.stage] + "]";
}
const rows: {
  phase: StoragePhase;
  status: string;
  time: number;
  detail: string;
}[] = [];
export function storageFailureText(result: unknown): string {
  const value = result as { status?: unknown; reason?: unknown } | null;
  const key =
    value?.reason === "timeout"
      ? "timeout"
      : typeof value?.status === "string" && Object.hasOwn(labels, value.status)
        ? value.status
        : "unavailable";
  return labels[key] + safeDetail(result);
}
export function recordStorageDiagnostic(
  phase: StoragePhase,
  result: unknown,
): void {
  if (!["probe", "write", "retry"].includes(phase)) return;
  const value = result as { status?: unknown; reason?: unknown } | null;
  const status =
    value?.reason === "timeout"
      ? "timeout"
      : typeof value?.status === "string" && Object.hasOwn(labels, value.status)
        ? value.status
        : "unavailable";
  rows.push({ phase, status, time: Date.now(), detail: safeDetail(result) });
  if (rows.length > 64) rows.shift();
  if (typeof window !== "undefined")
    window.dispatchEvent(new Event("wa-translate:incoming-status"));
}
export function getStorageDiagnostics(): string[] {
  return rows.map(
    (r) =>
      `${r.time} [本地保存] ${r.phase}_${r.status} · ${labels[r.status]}${r.detail}`,
  );
}
export function clearStorageDiagnostics(): void {
  rows.length = 0;
}
