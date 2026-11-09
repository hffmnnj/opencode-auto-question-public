import { Plugin } from "@opencode/plugin";
import { startAutoQuestion } from "./runtime.ts";
import { createLocalClient } from "./local-client.ts";

export default Plugin.define({
  id: "opencode-auto-question",
  async setup(ctx) {
    const controller = new AbortController();
    const requestOptions = () => ({
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]),
    });
    const client = await createLocalClient(ctx.app.version, process.pid, requestOptions().signal);
    const runtime = startAutoQuestion({
      directory: ctx.location.directory,
      workspaceID: ctx.location.workspaceID,
      clock: { now: () => Date.now() },
      scheduler: {
        schedule: (delayMs, callback) => {
          const timer = setTimeout(callback, delayMs);
          return () => clearTimeout(timer);
        },
      },
      storage: ctx.storage,
      events: ctx.event.subscribe({ signal: controller.signal }),
      forms: {
        get: (sessionID, formID) => client.session.form.get({ sessionID, formID }, requestOptions()),
        reply: (sessionID, formID, answer) => client.session.form.reply({ sessionID, formID, answer }, requestOptions()),
      },
      sessions: {
        locationOf: async (sessionID) => {
          try {
            const info = await ctx.session.get({ sessionID });
            return info.location;
          } catch {
            return undefined;
          }
        },
      },
    });
    return () => {
      controller.abort();
      runtime.dispose();
    };
  },
});
