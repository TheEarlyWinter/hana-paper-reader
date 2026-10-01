import { confirmAction } from "./confirm-dialog.js";
import { validateMigrationReceipt } from "./migration-receipt.js";
const KEY = "hana-paper-reader-migration-plan-v1";
const MAX_BYTES = 256 * 1024 * 1024;
const PLAN_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const object = value => value && typeof value === "object" && !Array.isArray(value);
const badReceipt = () => new Error("迁移回执无法核对，请刷新结果或重新选择原文件");
const progressBasis = value => value ? JSON.stringify([value.state, value.imported, value.kept, value.failed]) : "";
function verifiedPlan(value, expected = null) {
  try { return validateMigrationReceipt(value, expected); } catch { throw badReceipt(); }
}
function preparationSource(raw) {
  let input;
  try { input = JSON.parse(raw); } catch { throw new Error("迁移文件不是有效 JSON"); }
  if (!object(input) || input.format !== "hana-paper-reader-migration" || input.version !== 1
      || input.sensitiveConfigPolicy !== "manual-reentry" || typeof input.sourceFingerprint !== "string" || !HASH.test(input.sourceFingerprint)
      || !Array.isArray(input.papers) || input.papers.length > 1000) throw new Error("迁移文件来源无法核对");
  const hashes = input.papers.map(paper => typeof paper?.paperHash === "string" ? paper.paperHash.toLowerCase() : "");
  if (hashes.some(hash => !HASH.test(hash)) || new Set(hashes).size !== hashes.length) throw new Error("迁移文件论文指纹无效或重复");
  return { fingerprint: input.sourceFingerprint, hashes };
}
const esc = value => String(value || "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));

export function createMigrationUi({ apiFetch, toast, onChanged }) {
  const modal = document.createElement("div");
  modal.className = "session-target-modal"; modal.setAttribute("aria-hidden", "true");
  modal.innerHTML = `<div class="session-target-backdrop" data-migration-close></div>
    <section class="session-target-dialog" role="dialog" aria-modal="true" aria-labelledby="migration-title">
      <div class="session-target-header"><div><h2 id="migration-title">导入旧版研究数据</h2>
        <p>选择从停写快照生成的迁移文件。已有论文保持原样，旧版数据单独保留；MinerU Token 请在设置中重新输入。</p></div>
        <button type="button" class="icon-button" data-migration-close aria-label="关闭迁移">✕</button></div>
      <div class="session-target-status" role="status" data-migration-status>请选择迁移文件。</div>
      <input type="file" accept=".json,application/json" hidden data-migration-input>
      <div class="session-target-list" data-migration-rows></div>
      <div class="session-target-footer"><button type="button" class="btn small" data-migration-select>选择迁移文件</button>
        <button type="button" class="btn small" data-migration-refresh>刷新结果</button>
        <button type="button" class="btn small" data-migration-receipt>下载回执</button>
        <button type="button" class="btn primary small" data-migration-commit>导入缺失论文</button></div>
    </section>`;
  document.body.append(modal);
  const find = key => modal.querySelector(`[data-migration-${key}]`);
  let plan = null; let busy = false; let planId = ""; let planReady = false; let confirmationPending = null;
  let uiRevision = 0;
  try { const stored = localStorage.getItem(KEY); if (typeof stored === "string" && PLAN_ID.test(stored)) planId = stored; } catch { /* optional UI resume */ }
  const message = (value, tone = "") => { find("status").textContent = value; find("status").dataset.tone = tone; };
  const remember = id => { planId = id; try { localStorage.setItem(KEY, id); } catch { /* status remains in host App data */ } };
  function render() {
    find("select").disabled = busy;
    find("refresh").disabled = busy || !planId;
    find("receipt").disabled = busy || !plan;
    find("commit").disabled = busy || Boolean(confirmationPending) || !planReady || plan?.state !== "prepared" || !plan.rows.some(row => row.action === "import");
    find("rows").innerHTML = !plan ? "" : `<p>${plan.rows.length} 篇来源论文；已导入 ${plan.imported.length} 篇，保留当前论文 ${plan.kept.length} 篇，失败 ${plan.failed.length} 篇。</p>`
      + plan.rows.map(row => `<div class="session-target-option"><span class="session-target-option-main"><strong>${esc(row.title)}</strong>
        <span>${row.action === "import" ? "导入缺失论文" : "保留当前论文，隔离旧版数据"} · 笔记 ${row.notes} · 书签 ${row.bookmarks} · 资源 ${row.assets}</span></span>
        <button type="button" class="btn small" data-migration-paper="${esc(row.paperHash)}" ${busy ? "disabled" : ""}>下载旧版备份</button></div>`).join("");
  }
  async function request(url, init) {
    const response = await apiFetch(url, init); const data = await response.json();
    if (!response.ok || !object(data) || data.ok !== true) throw new Error(typeof data?.error === "string" ? data.error : data?.error?.message || "迁移接口不可用");
    return data;
  }
  function describe() {
    const states = { prepared: "差异已列出。点击导入，只补充缺失论文；现有论文不会被替换。", importing: "正在导入，请稍后刷新结果。",
      completed: "导入完成。已有论文保留；旧版备份可分别下载后查看。", partial: "部分论文导入失败，已完成的论文保留。请下载回执；重新选择原文件会跳过已有论文。",
      interrupted: "导入被中断，已完成的论文保留。请下载回执；重新选择原文件会跳过已有论文。" };
    message(states[plan.state] || "请查看迁移回执。", ["partial", "interrupted"].includes(plan.state) ? "error" : "");
  }
  async function refresh() {
    if (busy || !planId) return; uiRevision += 1; busy = true; planReady = false; render();
    const id = planId, expected = plan, revision = uiRevision;
    try {
      const next = verifiedPlan((await request(`/api/migration/${encodeURIComponent(id)}`)).plan, expected);
      if (next.planId !== id) throw badReceipt();
      plan = next; planReady = true; describe();
      if (["completed", "partial", "interrupted"].includes(next.state) && (next.imported.length || next.kept.length)
          && progressBasis(next) !== progressBasis(expected)) {
        try { await onChanged?.(); }
        catch { if (revision === uiRevision) message("迁移结果已经保存，文库列表刷新失败，请重新打开文库。"); }
      }
    }
    catch (error) { message(error.message, "error"); }
    finally { busy = false; render(); }
  }
  async function prepare(file) {
    if (busy || !file) return;
    uiRevision += 1; planReady = false; render();
    if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_BYTES) { message("迁移文件为空或超过 256 MiB；先前计划须刷新核对后才能导入。", "error"); return; }
    busy = true; render(); message("正在读取迁移文件并准备差异列表…");
    try {
      const raw = await file.text();
      if (typeof raw !== "string" || !raw || new Blob([raw]).size > MAX_BYTES) throw new Error("迁移文件为空或超过 256 MiB");
      const source = preparationSource(raw);
      const result = await request("/api/migration/prepare", { method: "POST", headers: { "Content-Type": "application/json" }, body: raw });
      const next = verifiedPlan(result.plan);
      if (next.state !== "prepared" || next.sourceFingerprint !== source.fingerprint
          || JSON.stringify(next.rows.map(row => row.paperHash)) !== JSON.stringify(source.hashes)) throw badReceipt();
      plan = next; planReady = true; remember(plan.planId); describe();
    } catch (error) { message((error.message || "迁移文件无法准备") + "；先前计划须刷新核对后才能导入。", "error"); }
    finally { busy = false; render(); }
  }
  async function commit() {
    if (busy || confirmationPending || !planReady || plan?.state !== "prepared" || !plan.rows.some(row => row.action === "import")) return;
    const id = plan.planId;
    const expected = plan;
    const revision = uiRevision;
    const count = plan.rows.filter(row => row.action === "import").length;
    const confirmation = { expected, revision }; confirmationPending = confirmation; render();
    let accepted = false;
    try { accepted = await confirmAction(`将导入最多 ${count} 篇缺失论文。相同指纹的现有论文保持原样，旧任务不会自动恢复。确认继续？`, { title: "导入旧版数据", confirmText: "导入" }); }
    catch { if (revision === uiRevision) message("无法确认导入，请重新打开迁移窗口。", "error"); }
    finally { if (confirmationPending === confirmation) { confirmationPending = null; render(); } }
    if (!accepted) return;
    if (busy || !planReady || revision !== uiRevision || !modal.classList.contains("open") || plan !== expected || plan.state !== "prepared") return;
    busy = true; planReady = false; render(); message("正在导入缺失论文…");
    try {
      const next = verifiedPlan((await request(`/api/migration/${encodeURIComponent(id)}/commit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).plan, expected);
      if (next.state === "prepared") throw badReceipt();
      plan = next; planReady = true;
      describe();
      if (plan.state === "importing") return;
      try { await onChanged?.(); }
      catch { if (revision === uiRevision) message("迁移结果已经保存，文库列表刷新失败，请重新打开文库或刷新结果。"); }
      try { if (revision === uiRevision && modal.classList.contains("open")) await toast?.({ message: plan.state === "completed" ? "旧版数据导入完成" : "迁移结果已保存，请查看回执", type: plan.state === "completed" ? "success" : "error" }); }
      catch { /* The saved result must not become a false import failure. */ }
    } catch (error) { message(`${error.message}。结果可能已经保存，请刷新核对；不会自动重试导入。`, "error"); }
    finally { busy = false; render(); }
  }
  async function download(url, name, hash = null) {
    const revision = uiRevision;
    const expected = plan;
    const current = () => revision === uiRevision && modal.classList.contains("open") && plan === expected;
    try {
      const response = await apiFetch(url);
      if (!response.ok) throw new Error("下载失败，请刷新迁移结果");
      const data = await response.json();
      if (!current()) return;
      if (hash) {
        if (!object(data) || data.format !== "hana-paper-reader-backup" || data.version !== 1 || data.paperHash !== hash
            || !object(data.paper) || data.paper.paperHash !== hash) throw badReceipt();
      } else verifiedPlan(data, expected);
      if (!current()) return;
      const blob = new Blob([JSON.stringify(data)], { type: "application/json" }); const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a"); anchor.href = href; anchor.download = name; anchor.click();
      setTimeout(() => URL.revokeObjectURL(href), 1000);
    } catch (error) { if (current()) message(error.message, "error"); }
  }
  find("select").addEventListener("click", () => find("input").click());
  find("input").addEventListener("change", event => { const file = event.target.files?.[0]; event.target.value = ""; void prepare(file); });
  find("refresh").addEventListener("click", () => void refresh());
  find("commit").addEventListener("click", () => void commit());
  find("receipt").addEventListener("click", () => { if (plan && !busy && modal.classList.contains("open")) void download(`/api/migration/${encodeURIComponent(plan.planId)}/receipt`, `migration-${plan.planId}.receipt.json`); });
  find("rows").addEventListener("click", event => {
    const hash = event.target.closest("[data-migration-paper]")?.dataset.migrationPaper;
    if (hash && plan && !busy && modal.classList.contains("open") && plan.rows.some(row => row.paperHash === hash)) void download(`/api/migration/${encodeURIComponent(plan.planId)}/papers/${encodeURIComponent(hash)}`, `isolated-${hash.slice(0, 12)}.backup.json`, hash);
  });
  const close = () => { uiRevision += 1; modal.classList.remove("open"); modal.setAttribute("aria-hidden", "true"); };
  modal.querySelectorAll("[data-migration-close]").forEach(button => button.addEventListener("click", close));
  document.addEventListener("keydown", event => { if (event.key === "Escape" && modal.classList.contains("open")) { close(); event.stopPropagation(); } });
  return { open() { uiRevision += 1; modal.classList.add("open"); modal.setAttribute("aria-hidden", "false"); render(); if (planId && !busy) void refresh(); } };
}
