import type { Config } from "@/shared/types";
import { configured } from "@/shared/types";
import { TranslationError, safeTranslationError } from "@/shared/errors";
export const CONNECTION_TEST_TEXT = "Connection test. Reply OK.";
export async function testModelConnection(
  load: () => Promise<Config>,
  call: (
    config: Config,
    args: { system: string; user: string },
  ) => Promise<string>,
  now = Date.now,
) {
  const start = now();
  try {
    const config = await load();
    if (config.mode !== "llm" || !configured(config))
      throw new TranslationError("configuration");
    const snapshot = JSON.stringify(config);
    await call(config, {
      system: "This is a connectivity test. Reply only OK.",
      user: CONNECTION_TEST_TEXT,
    });
    if (JSON.stringify(await load()) !== snapshot)
      throw new TranslationError("cancelled");
    return {
      ok: true as const,
      elapsedMs: Math.max(0, Math.round(now() - start)),
    };
  } catch (error) {
    const safe = safeTranslationError(error);
    return {
      ok: false as const,
      elapsedMs: Math.max(0, Math.round(now() - start)),
      code: safe.code,
      ...(safe.status ? { status: safe.status } : {}),
    };
  }
}
