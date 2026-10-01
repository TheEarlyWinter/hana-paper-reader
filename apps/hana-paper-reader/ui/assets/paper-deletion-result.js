export function paperDeletionNotice(result, successMessage = "论文及其全部研究数据已删除。") {
  const cleanup = result?.cleanup || result || {};
  if (cleanup.paperDirectory === "preserved") {
    return { message: "原论文已删除；其他窗口重新创建的同一论文及其文件已保留，请刷新文库核对", type: "warning" };
  }
  if (cleanup.cleanupDeferred) {
    return { message: "论文已移出文库，部分磁盘文件尚未清理，请检查工作区", type: "warning" };
  }
  if (cleanup.preservedCacheIds?.length) {
    return { message: "论文及其专属数据已删除；其他论文仍引用的共享缓存已保留", type: "success" };
  }
  return { message: successMessage, type: "success" };
}

export function paperDeletionRevision(paper, paperHash) {
  if (typeof paper?.paperHash !== "string" || paper.paperHash.trim().toLowerCase() !== String(paperHash || "").trim().toLowerCase()) {
    throw new Error("论文已切换或无法确认，请重新载入后再删除");
  }
  if (!Number.isSafeInteger(paper.revision) || paper.revision < 0) {
    throw new Error("无法确认论文版本，请重新载入后再删除");
  }
  return paper.revision;
}
