import { directoryTestMessage } from "@/shared/directory-selftest";
import { useEffect, useState } from "react";
import {
  chooseDirectoryForHistory,
  loadDirectorySelection,
  reauthorizeHistoryDirectory,
  type StoredDirectorySelection,
} from "@/shared/directory-selection";
interface Policy {
  mode: "browser" | "directory";
  maxMiB: number;
  revision: string;
  directoryId?: string;
}
export function HistorySettingsPanel() {
  const [policy, setPolicy] = useState<Policy>({
    mode: "browser",
    maxMiB: 4,
    revision: "initial",
  });
  const [locationKey, setLocationKey] = useState<string | null>(null);
  const [selection, setSelection] = useState<StoredDirectorySelection | null>(
    null,
  );
  const [capacity, setCapacity] = useState("4");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const reload = async () => {
    const result = await chrome.runtime.sendMessage({
      kind: "TRANSLATION_HISTORY",
      action: "settings",
    });
    if (result?.status !== "ok") throw Error();
    setPolicy(result.settings);
    setCapacity(String(result.settings.maxMiB));
    setLocationKey(result.locationKey);
    setSelection(await loadDirectorySelection(result.settings.directoryId));
  };
  useEffect(() => {
    void reload().catch(() => setMessage("保存设置读取失败，请重新打开此页。"));
  }, []);
  const resultMessage = (status: string) =>
    status === "ok"
      ? "保存设置已更新。"
      : status === "conflict"
        ? "保存位置已在另一设置页改变，已停止操作；请刷新设置后再试。"
        : status === "permission"
          ? "目录权限已过期，请点击重新授权；期间不另存其他位置。"
          : status === "corrupt"
            ? "本扩展目录记录校验失败，未修改未知文件；请保留目录并检查。"
            : "本地存储暂不可用，未静默改存其他位置。";
  const configure = async (
    mode: Policy["mode"],
    limit = Number(capacity),
    selectionId?: string,
  ) => {
    const max = mode === "browser" ? 8 : 1024;
    if (!Number.isInteger(limit) || limit < 1 || limit > max) {
      setMessage(`容量须为1至${max}MiB整数。`);
      return;
    }
    const result = await chrome.runtime.sendMessage({
      kind: "TRANSLATION_HISTORY",
      action: "configure",
      settings: { mode, maxMiB: limit },
      locationKey,
      selectionId,
    });
    if (result?.settings) {
      setPolicy(result.settings);
      setCapacity(String(result.settings.maxMiB));
      setLocationKey(result.locationKey);
      setSelection(await loadDirectorySelection(result.settings.directoryId));
    }
    setMessage(resultMessage(result?.status));
  };
  const run = async (task: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await task();
    } catch {
      setMessage(
        "操作未完成：可能已取消、浏览器不支持或目录权限不可用。原有记录不会自动迁移。",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="opts-section">
      <h2>本地接收译文</h2>
      <p role="status">
        目录仅在设置时授权。扩展会核对当前页面账号，并分账号保存；这依赖
        WhatsApp
        页面内部账号模块，不能抵御同源恶意脚本篡改。无法取得账号时不保存或恢复。
      </p>
      <p>
        只恢复当前可见消息已有的译文，不自动发送历史文本。原消息不改写；原文在上、译文在下。记录按账号、消息身份、原文摘要、目标绑定；保留当时供应商来源，不另存原文或密钥。更换供应商不会自动重译，点击消息旁“译”才按新服务重译。
      </p>
      <p>
        当前保存位置：
        {policy.mode === "browser"
          ? "扩展本地库"
          : `已选目录 / ${selection?.displayName ?? "需要重新选择"}`}
      </p>
      <p>
        目录模式在所选目录下创建本扩展专属子目录，优先按已验证原消息日期和对话摘要保存；原消息时间缺失时使用保存日期并在记录内标记。切换位置不会自动迁移或合并旧记录；切回原目录可继续读取仍保留的记录。文件包含译文，未另行加密。
      </p>
      <div className="opts-row">
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              // This call is the first async action under the actual click.
              const next = await chooseDirectoryForHistory();
              await configure("directory", Number(capacity), next.selectionId);
            })
          }
        >
          选择保存目录
        </button>
        <button
          type="button"
          disabled={busy || !selection}
          onClick={() =>
            void run(async () => {
              if (
                !selection ||
                !(await reauthorizeHistoryDirectory(selection))
              ) {
                setMessage("未取得目录写入权限，仍等待授权。");
                return;
              }
              await configure(
                "directory",
                Number(capacity),
                selection.selectionId,
              );
            })
          }
        >
          重新授权所选目录
        </button>
        <button
          type="button"
          disabled={busy || policy.mode === "browser"}
          onClick={() =>
            void run(() => configure("browser", Math.min(8, Number(capacity))))
          }
        >
          使用扩展本地库
        </button>
      </div>
      <p>
        目录读写测试仅在点击时执行，写入固定无敏感样本并读回，随后清理本次测试数据；不访问已有译文。
      </p>
      <button
        type="button"
        disabled={
          busy || policy.mode !== "directory" || !selection || !locationKey
        }
        onClick={() =>
          void run(async () => {
            setMessage("正在测试目录权限、写入、读回和清理…");
            const result = await chrome.runtime.sendMessage({
              kind: "TRANSLATION_HISTORY",
              action: "test_directory",
              locationKey,
            });
            setMessage(directoryTestMessage(result));
          })
        }
      >
        测试目录读写
      </button>
      <div className="opts-row">
        <label htmlFor="translation-history-limit">容量上限（MiB）</label>
        <input
          id="translation-history-limit"
          type="number"
          min={1}
          max={policy.mode === "browser" ? 8 : 1024}
          step={1}
          value={capacity}
          onChange={(e) => setCapacity(e.target.value)}
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(() => configure(policy.mode))}
        >
          保存容量上限
        </button>
      </div>
      <p>
        超过容量时按原消息时间从旧到新自动清理；缺失时间的记录按保存时间排序。只删除本扩展可验证的译文记录，不碰其他文件。扩展库最多1000条，目录最多10000条；达到条数上限也清理最旧记录。无时间到期，但清理、卸载或用户删除会失去记录，不保证永久保存。目录权限过期会提示，需重新授权。
      </p>
      <button
        type="button"
        disabled={busy}
        onClick={() =>
          void run(async () => {
            if (
              !window.confirm(
                "清空当前保存位置内本扩展的全部账号译文？不删除WhatsApp原消息，但此操作不可撤销。",
              )
            )
              return;
            const result = await chrome.runtime.sendMessage({
              kind: "TRANSLATION_HISTORY",
              action: "clear",
              locationKey,
            });
            if (result?.status === "ok") await reload();
            setMessage(
              result?.status === "ok"
                ? "当前保存位置的本地译文已清空。"
                : resultMessage(result?.status),
            );
          })
        }
      >
        清空当前保存位置的译文
      </button>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
