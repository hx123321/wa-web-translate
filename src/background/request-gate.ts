import { getLanguage } from "@/shared/languages";
import type { TranslateRequest } from "@/shared/types";
export class TranslationGate {
  private active = 0;
  private recent: number[] = [];
  async run<T>(req: TranslateRequest, execute: () => Promise<T>): Promise<T> {
    const now = Date.now();
    while (this.recent.length && this.recent[0] <= now - 60000)
      this.recent.shift();
    if (this.active >= 4 || this.recent.length >= 60)
      throw new Error("Translation busy. Please retry shortly.");
    if (
      !req ||
      typeof req.text !== "string" ||
      req.text.length > 5000 ||
      typeof req.target !== "string" ||
      !getLanguage(req.target) ||
      (req.source !== undefined &&
        (typeof req.source !== "string" ||
          (req.source !== "auto" && !getLanguage(req.source))))
    )
      throw new Error("Invalid translation request (maximum 5000 characters).");
    this.recent.push(now);
    this.active++;
    try {
      return await execute();
    } finally {
      this.active--;
    }
  }
}
