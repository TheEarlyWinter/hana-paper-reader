export function chunkTranslationBlocks(blocks, batchSize = 2) {
  const list = Array.isArray(blocks) ? blocks : [];
  const size = Math.max(1, Math.min(24, Number(batchSize) || 2));
  const batches = [];
  for (let index = 0; index < list.length; index += size) {
    batches.push(list.slice(index, index + size));
  }
  return batches;
}

export async function runConcurrentTranslationBatches({
  blocks = [],
  batchSize = 2,
  concurrency = 2,
  isCurrent = () => true,
  shouldPause = () => false,
  onProgress = null,
  executeBatch,
}) {
  const batches = chunkTranslationBlocks(blocks, batchSize);
  const maxWorkers = Math.max(1, Math.min(6, Number(concurrency) || 2, batches.length || 1));
  let cursor = 0;
  let completedCount = 0;
  let failedCount = 0;
  let paused = false;

  const reportProgress = () => {
    if (typeof onProgress === "function") {
      onProgress({
        completedCount,
        failedCount,
        totalCount: blocks.length,
        remainingCount: Math.max(0, blocks.length - completedCount - failedCount),
        paused,
      });
    }
  };

  async function worker() {
    while (cursor < batches.length) {
      if (!isCurrent()) return;
      if (shouldPause()) {
        paused = true;
        return;
      }
      const batchIndex = cursor;
      cursor += 1;
      const slice = batches[batchIndex];
      const outcome = await executeBatch(slice, batchIndex);
      if (!isCurrent()) return;
      if (outcome && typeof outcome === "object") {
        completedCount += Number(outcome.completed) || 0;
        failedCount += Number(outcome.failed) || 0;
      } else {
        completedCount += slice.length;
      }
      reportProgress();
      if (shouldPause() && cursor < batches.length) {
        paused = true;
        return;
      }
    }
  }

  await Promise.all(Array.from({ length: maxWorkers }, () => worker()));
  const processedCount = completedCount + failedCount;
  const remainingBlocks = paused ? batches.slice(cursor).flat() : [];
  return {
    completedCount,
    failedCount,
    totalCount: blocks.length,
    remainingCount: Math.max(0, blocks.length - processedCount),
    remainingBlocks,
    paused,
  };
}
