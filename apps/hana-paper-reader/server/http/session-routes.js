import { createSessionDelivery, SessionDeliveryError } from "../domain/session-delivery.js";
import { readBoundedRequestText, RequestBodyError } from "./request-body.js";

export default function registerSessionRoutes(app, runtime) {
  const delivery = createSessionDelivery(runtime);
  function principal(c) {
    const p = c.get?.("appRequestContext")?.principal;
    return typeof (p?.principalId || p?.id) === "string" ? (p.principalId || p.id).trim() : "";
  }
  const endpoint = handler => async c => {
    const id = principal(c);
    if (!id) return c.json({ ok: false, error: { code: "app_request_context_required", message: "需要 Hana App UI 授权" } }, 403);
    c.header?.("Cache-Control", "private, no-store");
    try { return c.json(await handler(c, id)); }
    catch (error) {
      const safe = error instanceof SessionDeliveryError;
      return c.json({ ok: false, error: { code: safe ? error.code : "session_delivery_failed",
        message: safe ? error.message : "对话接口暂时不可用，请检查宿主权限或稍后重试" },
        ...(safe ? error.details : {}), apiVersion: "1.0.0" }, safe ? error.status : 503);
    }
  };
  app.get("/api/session-targets", endpoint(async (_, id) => ({ ok: true, sessions: await delivery.list(id), apiVersion: "1.0.0" })));
  app.get("/api/session-delivery/:requestId", endpoint((c, id) => delivery.status(id, c.req.param("requestId"))));
  for (const [route, create] of [["/api/send-to-session", false], ["/api/create-session-and-send", true]]) {
    app.post(route, endpoint(async (c, id) => {
      let raw;
      try { raw = await readBoundedRequestText(c.req, 128 * 1024); }
      catch (error) {
        if (!(error instanceof RequestBodyError)) throw error;
        throw new SessionDeliveryError("session_quote_invalid", error.status === 413 ? "引用请求过大" : "引用请求不是有效 UTF-8 文本或读取已取消", error.status);
      }
      let body;
      try { body = JSON.parse(raw); } catch { throw new SessionDeliveryError("session_quote_invalid", "引用请求无效"); }
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new SessionDeliveryError("session_quote_invalid", "引用请求无效");
      return delivery.deliver(id, body, create);
    }));
  }
}
