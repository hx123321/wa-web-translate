import { getLanguage } from "@/shared/languages";
export function directionSymbol(code: string | null | undefined): string {
  if (!code || !getLanguage(code)) return "关";
  if (code === "zh-CN") return "简中";
  if (code === "zh-TW") return "繁中";
  return code.toUpperCase();
}
// Keep an observed failure visible until a later success or explicit closure.
export function diagnosticWarning(records: { stage: string }[]): boolean {
  for (let i = records.length - 1; i >= 0; i--) {
    const stage = records[i].stage;
    if (
      [
        "translated",
        "response_received",
        "preview_ready",
        "wa_send_resolved",
        "closed",
      ].includes(stage)
    )
      return false;
    if (stage === "failed_cancelled" || stage === "failed_disabled") continue;
    if (
      stage === "failed" ||
      stage.startsWith("failed_") ||
      stage.startsWith("timeout_") ||
      stage === "wa_send_failed" ||
      stage === "send_blocked"
    )
      return true;
  }
  return false;
}
