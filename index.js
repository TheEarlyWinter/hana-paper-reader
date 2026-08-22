
const HANA_BUS_SKIP = Symbol.for("hana.event-bus.skip");

export default class Plugin {
  async onload() {
    const ctx = this.ctx;
    if (ctx.bus.handle) {
      this.register(ctx.bus.handle("hana-paper-reader:status", (payload) => {
        if (payload?.pluginId && payload.pluginId !== ctx.pluginId) return HANA_BUS_SKIP;
        return {
          ok: true,
          pluginId: ctx.pluginId,
          name: "Hana Paper Reader",
        };
      }));
    }
    ctx.log.info("Hana Paper Reader loaded");
  }

  async onunload() {
    this.ctx.log.info("Hana Paper Reader unloaded");
  }
}
