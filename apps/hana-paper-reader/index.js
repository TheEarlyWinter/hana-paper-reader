import { defineApp } from "./sdk/app-contract/server-client.js";
import registerApiRoutes from "./server/http/api-routes.js";
import { createMineruSettingsStore } from "./server/domain/mineru-settings.js";

export const name = "hana-paper-reader";

export default defineApp(async (sdk) => {
  await sdk.logger.info("Hana Paper Reader v2 loaded");
  const settings = createMineruSettingsStore(sdk.dataDir);
  await sdk.routes.register((app) => {
    registerApiRoutes(app, {
      dataDir: sdk.dataDir,
      settings,
      network: sdk.network,
      models: sdk.models,
      agents: sdk.agents,
      sessions: sdk.sessions,
      capabilities: sdk.capabilities,
      logger: sdk.logger,
    });
  });
});
