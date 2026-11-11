import type { HistoryDirectory, HistoryFile } from "./directory-history";
export type DirectoryTestStage =
  | "permission"
  | "nested_open"
  | "write"
  | "read"
  | "cleanup";
export interface DirectoryTestResult {
  status: "ok" | "permission" | "conflict" | "unavailable";
  stage: DirectoryTestStage;
  residue: boolean;
}
const sample = "WA translation directory read/write test. No user data.";
async function same(
  a: HistoryDirectory | HistoryFile,
  b: HistoryDirectory | HistoryFile,
) {
  const fn = (
    a as unknown as { isSameEntry?: (other: unknown) => Promise<boolean> }
  ).isSameEntry;
  return typeof fn === "function" && (await fn.call(a, b));
}
// Explicit options action only. Never probes existing translation records.
export async function testHistoryDirectory(
  root: HistoryDirectory,
  isCurrent: () => Promise<boolean>,
): Promise<DirectoryTestResult> {
  let stage: DirectoryTestStage = "permission",
    residue = false;
  const result = (
    status: DirectoryTestResult["status"],
  ): DirectoryTestResult => ({ status, stage, residue });
  const valid = async () => {
    if (!(await isCurrent())) return "conflict" as const;
    if ((await root.queryPermission({ mode: "readwrite" })) !== "granted")
      return "permission" as const;
    return null;
  };
  try {
    let stop = await valid();
    if (stop) return result(stop);
    stage = "write";
    const token = crypto.randomUUID();
    const name = `wa-translate-tests-${token}`;
    // No overwrite: any existing name, wrong kind or uncertain lookup stops.
    try {
      await root.getDirectoryHandle(name);
      return result("conflict");
    } catch (error) {
      if ((error as { name?: string })?.name !== "NotFoundError") throw error;
    }
    stop = await valid();
    if (stop) return result(stop);
    const dir = await root.getDirectoryHandle(name, { create: true });
    residue = true;
    if (!dir.entries) throw Error();
    for await (const _entry of dir.entries()) return result("conflict");
    stage = "nested_open";
    const chain: {
      parent: HistoryDirectory;
      child: HistoryDirectory;
      name: string;
    }[] = [{ parent: root, child: dir, name }];
    let leaf = dir;
    for (const segment of ["2000-01-01", "a".repeat(43), "b".repeat(43)]) {
      stop = await valid();
      if (stop) return result(stop);
      const child = await leaf.getDirectoryHandle(segment, { create: true });
      if (!child.entries) throw Error();
      for await (const _entry of child.entries()) return result("conflict");
      chain.push({ parent: leaf, child, name: segment });
      leaf = child;
    }
    const filename = "c".repeat(32) + ".zh-CN.json";
    stop = await valid();
    if (stop) return result(stop);
    const file = await leaf.getFileHandle(filename, { create: true });
    stage = "write";
    const empty = await file.getFile();
    if (empty.size !== 0) return result("conflict");
    const text = JSON.stringify({
      format: "wa-directory-selftest-v1",
      token,
      sample,
    });
    stop = await valid();
    if (stop) return result(stop);
    const writer = await file.createWritable();
    try {
      await writer.write(text);
      await writer.close();
    } catch (error) {
      try {
        await writer.abort?.();
      } catch {}
      throw error;
    }
    stage = "read";
    stop = await valid();
    if (stop) return result(stop);
    const read = await file.getFile();
    if (read.size > 1024 || (await read.text()) !== text)
      return result("unavailable");
    stage = "cleanup";
    stop = await valid();
    if (stop) return result(stop);
    if (
      !(await same(dir, await root.getDirectoryHandle(name))) ||
      !(await same(file, await leaf.getFileHandle(filename)))
    )
      return result("conflict");
    const final = await file.getFile();
    if (final.size > 1024 || (await final.text()) !== text)
      return result("conflict");
    for (const part of chain)
      if (
        !(await same(
          part.child,
          await part.parent.getDirectoryHandle(part.name),
        ))
      )
        return result("conflict");
    for await (const [entry] of leaf.entries!())
      if (entry !== filename) return result("conflict");
    stop = await valid();
    if (stop) return result(stop);
    await leaf.removeEntry(filename);
    // Non-recursive removal refuses any concurrently added content.
    for (const part of chain.reverse()) {
      stop = await valid();
      if (stop) return result(stop);
      if (
        !(await same(
          part.child,
          await part.parent.getDirectoryHandle(part.name),
        ))
      )
        return result("conflict");
      await part.parent.removeEntry(part.name);
    }
    residue = false;
    return result("ok");
  } catch {
    return result("unavailable");
  }
}
export function directoryTestMessage(value: unknown): string {
  const r = value as Partial<DirectoryTestResult> | null;
  const label =
    (
      {
        permission: "权限检查",
        nested_open: "等长嵌套路径创建",
        write: "写入",
        read: "读回校验",
        cleanup: "清理",
      } as const
    )[r?.stage as DirectoryTestStage] ?? "目录检查";
  if (r?.status === "ok")
    return "目录测试通过：权限、写入、读回及测试数据清理均成功。";
  const detail =
    r?.status === "permission"
      ? "权限不足，请点击重新授权后再试。"
      : r?.status === "conflict"
        ? "位置或测试对象发生变化，已停止以保护文件。"
        : "未完成，请检查目录可用性后再试。";
  return `${label}：${detail}${r?.residue ? "可能留有本次专属测试子目录；未删除任何不确定数据。" : ""}`;
}
