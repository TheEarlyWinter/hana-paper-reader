import { UI_VERSION, API_PROTOCOL_VERSION, BUILD_CHANNEL, PDF_PREVIEWER_ENABLED } from "../../ui/assets/build-info.js";

const count = value => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1000000000) : null;
const bool = value => typeof value === "boolean" ? value : null;
const choice = (value, allowed) => allowed.includes(value) ? value : null;

export function buildDiagnostics(runtime, client = {}) {
  // Whitelist every client field. Never spread request bodies, context objects,
  // errors, resource refs, model IDs or settings into a diagnostic artifact.
  const view = client && typeof client === "object" && !Array.isArray(client) ? client : {};
  return {
    format: "hana-paper-reader-diagnostics-v1", generatedAt: new Date().toISOString(),
    app: { id: "hana-paper-reader", version: UI_VERSION, apiVersion: API_PROTOCOL_VERSION, channel: BUILD_CHANNEL },
    features: {
      pdfPreviewerDeclared: PDF_PREVIEWER_ENABLED, pdfPreviewReadOnly: true,
      crossSessionDelivery: true, migrationImport: true, mineruSettings: "app-private-dpapi",
      pdfMaxBytes: 50 * 1024 * 1024, pdfPageCanvasPixels: 10000000,
      pdfCropCanvasPixels: 7000000, pdfOffscreenCacheTargetBytes: 64 * 1024 * 1024,
      pdfOffscreenCacheTargetItems: 12,
    },
    // Presence describes installed adapters, not a successful permission probe
    // or real external-service/model acceptance.
    adaptersPresent: {
      network: typeof runtime?.network?.fetch === "function",
      models: Boolean(runtime?.models), agents: Boolean(runtime?.agents), sessions: Boolean(runtime?.sessions),
    },
    clientSnapshot: {
      uiVersion: typeof view.uiVersion === "string" && /^\d+\.\d+\.\d+$/.test(view.uiVersion) ? view.uiVersion : null,
      visible: bool(view.visible), active: bool(view.active),
      slot: choice(view.slot, ["card", "page", "preview", "settings", "function-panel"]),
      readingMode: choice(view.readingMode, ["original", "bilingual", "translation", "contrast"]),
      paperLoaded: bool(view.paperLoaded), mineruConfigured: bool(view.mineruConfigured),
      modelCatalogReady: bool(view.modelCatalogReady), modelCount: count(view.modelCount), agentCount: count(view.agentCount),
      pdfLoaded: bool(view.pdfLoaded), pdfCachedImages: count(view.pdfCachedImages),
      pdfEstimatedCachedBytes: count(view.pdfEstimatedCachedBytes), pdfQueuedPageLocks: count(view.pdfQueuedPageLocks),
    },
  };
}
