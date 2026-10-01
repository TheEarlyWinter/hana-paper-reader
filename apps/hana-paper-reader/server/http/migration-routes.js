import { createMigrationImporter, MigrationImportError, MAX_MIGRATION_BYTES } from "../migration/migration-import.js";
import { readBoundedRequestText, RequestBodyError } from "./request-body.js";
export default function registerMigrationRoutes(app, runtime) {
  const importer = createMigrationImporter(runtime);
  function principal(c) {
    const p = c.get?.("appRequestContext")?.principal;
    const value = p?.principalId || p?.id;
    return typeof value === "string" ? value.trim() : "";
  }
  const endpoint = handler => async c => {
    const id = principal(c);
    if (!id) return c.json({ ok: false, error: { code: "app_request_context_required", message: "需要 Hana App UI 授权" } }, 403);
    c.header?.("Cache-Control", "private, no-store");
    try { return await handler(c, id); }
    catch (error) {
      const safe = error instanceof MigrationImportError;
      return c.json({ ok: false, error: { code: safe ? error.code : "migration_failed", message: safe ? error.message : "迁移请求失败，原有论文保留；请查看迁移回执" } }, safe ? error.status : 503);
    }
  };
  app.post("/api/migration/prepare", endpoint(async (c, id) => {
    let raw;
    try { raw = await readBoundedRequestText(c.req, MAX_MIGRATION_BYTES); }
    catch (error) {
      if (!(error instanceof RequestBodyError)) throw error;
      throw new MigrationImportError(error.status === 413 ? "migration_too_large" : "migration_invalid",
        error.status === 413 ? "迁移文件超过 256 MiB" : "迁移文件不是有效 UTF-8 文本或读取已取消", error.status);
    }
    let bundle;
    try { bundle = JSON.parse(raw); } catch { throw new MigrationImportError("migration_invalid", "迁移文件不是有效 JSON"); }
    return c.json({ ok: true, plan: importer.prepare(id, bundle), apiVersion: "1.0.0" });
  }));
  app.post("/api/migration/:planId/commit", endpoint(async (c, id) => c.json({ ok: true, plan: await importer.commit(id, c.req.param("planId")), apiVersion: "1.0.0" })));
  app.get("/api/migration/:planId", endpoint((c, id) => c.json({ ok: true, plan: importer.status(id, c.req.param("planId")), apiVersion: "1.0.0" })));
  app.get("/api/migration/:planId/receipt", endpoint((c, id) => c.json(importer.status(id, c.req.param("planId")))));
  app.get("/api/migration/:planId/papers/:paperHash", endpoint((c, id) => {
    const backup = importer.isolated(id, c.req.param("planId"), c.req.param("paperHash"));
    return new Response(JSON.stringify(backup), { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="isolated-${backup.paperHash.slice(0, 12)}.backup.json"` } });
  }));
}
