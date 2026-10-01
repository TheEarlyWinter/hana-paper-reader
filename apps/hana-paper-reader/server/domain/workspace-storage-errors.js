const storageStates = new Map([
  ["workspace_storage_busy", { message: "研究工作区正在写入，请稍后重试", status: 503 }],
  ["workspace_recovery_required", { message: "工作区事务无法自动恢复，记录已保留，请检查备份和存储权限", status: 503 }],
  ["workspace_rollback_failed", { message: "工作区回滚未完成，事务记录已保留，请重新检查工作区", status: 503 }],
  ["workspace_commit_uncertain", { message: "数据已写入，但提交状态需要核对，请重新载入后确认，勿重复提交", status: 503 }],
  ["workspace_conflict", { message: "研究工作区已被其他写入者更新，请重新载入后再保存", status: 409 }],
  ["workspace_integrity_error", { message: "工作区数据或版本历史无效，请检查备份后再继续", status: 503 }],
  ["paper_revision_exhausted", { message: "论文版本号已达到上限，无法安全写入", status: 409 }],
]);

// Return only fixed public text; native errors and file paths stay private.
export function storageStateFailure(error) {
  const state = storageStates.get(error?.code);
  return state ? { code: error.code, ...state } : null;
}
