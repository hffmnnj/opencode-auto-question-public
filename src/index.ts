import { OpenCode } from "@opencode/client";
import { Plugin } from "@opencode/plugin";
import { startAutoQuestion } from "./runtime.ts";

export default Plugin.define({
  id: "opencode-auto-question",
  async setup(ctx) {
    const controller = new AbortController();
    const password = process.env.OPENCODE_SERVER_PASSWORD;
    const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
    if (!password || username.includes(":")) {
      throw new Error("opencode-auto-question requires the existing server credentials.");
    }
    // The 2.0.32 plugin context omits forms. Use the official HTTP client,
    // bound to this installation's main server, without starting another host.
    const client = OpenCode.make({
      baseUrl: "http://127.0.0.1:4108",
      headers: { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` },
      fetch: Object.assign(
        (input: RequestInfo | URL, init?: RequestInit) => fetch(input, { ...init, redirect: "error" }),
        { preconnect: fetch.preconnect },
      ),
    });
    const requestOptions = () => ({
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]),
    });
    const server = await client.server.info(requestOptions());
    if (server.pid !== process.pid || server.version !== ctx.app.version) {
      throw new Error("opencode-auto-question refuses to answer forms on another OpenCode server.");
    }
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
        directoryOf: async (sessionID) => {
          try {
            const info = await ctx.session.get({ sessionID });
            return info.location.directory;
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
