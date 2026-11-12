import { Plugin } from "@opencode/plugin";
import { startAutoQuestion } from "./runtime.ts";
import { createLocalClient } from "./local-client.ts";
import { createQuestionRoutes } from "./routes.ts";
import { registerQuestionTools } from "./tools.ts";
import { registerQuestionAdvisory } from "./advisory.ts";

export default Plugin.define({
  id: "opencode-auto-question",
  async setup(ctx) {
    const useCurrentServer: unknown = ctx.options?.useCurrentServer;
    if (useCurrentServer !== undefined && typeof useCurrentServer !== "boolean") {
      throw new Error("useCurrentServer must be a boolean.");
    }
    const controller = new AbortController();
    const requestOptions = (signal?: AbortSignal) => ({
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5_000), ...(signal ? [signal] : [])]),
    });
    const client = await createLocalClient(ctx.app.version, process.pid, requestOptions().signal, { useCurrentServer });
    const forms = {
      get: (sessionID: string, formID: string, signal?: AbortSignal) => client.session.form.get({ sessionID, formID }, requestOptions(signal)),
      reply: (sessionID: string, formID: string, answer: Record<string, string | ReadonlyArray<string>>) =>
        client.session.form.reply({ sessionID, formID, answer }, requestOptions()),
    };
    const routes = createQuestionRoutes({
      storage: ctx.storage,
      forms,
      clock: { now: () => Date.now() },
      session: async (sessionID, signal) => ctx.session.get({ sessionID }, { signal }),
    });
    await registerQuestionTools(ctx, routes);
    await registerQuestionAdvisory(ctx, routes);
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
      forms,
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
